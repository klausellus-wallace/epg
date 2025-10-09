import { Logger, Timer, Storage, Collection } from '@freearhey/core'
import { QueueCreator, Job, ChannelsParser, TVHeadendFetcher, XMLTVMerger } from '../../core'
import { Option, program } from 'commander'
import { SITES_DIR } from '../../constants'
import { Channel } from 'epg-grabber'
import path from 'path'
import { ChannelList } from '../../models'

program
  .addOption(new Option('-s, --site <name>', 'Name of the site to parse'))
  .addOption(
    new Option(
      '-c, --channels <path>',
      'Path to *.channels.xml file (required if the "--site" attribute is not specified)'
    )
  )
  .addOption(new Option('-o, --output <path>', 'Path to output file').default('guide.xml'))
  .addOption(new Option('-l, --lang <codes>', 'Filter channels by languages (ISO 639-1 codes)'))
  .addOption(
    new Option('-t, --timeout <milliseconds>', 'Override the default timeout for each request').env(
      'TIMEOUT'
    )
  )
  .addOption(
    new Option('-d, --delay <milliseconds>', 'Override the default delay between request').env(
      'DELAY'
    )
  )
  .addOption(new Option('-x, --proxy <url>', 'Use the specified proxy').env('PROXY'))
  .addOption(
    new Option(
      '--days <days>',
      'Override the number of days for which the program will be loaded (defaults to the value from the site config)'
    )
      .argParser(value => parseInt(value))
      .env('DAYS')
  )
  .addOption(
    new Option('--maxConnections <number>', 'Limit on the number of concurrent requests')
      .default(1)
      .env('MAX_CONNECTIONS')
  )
  .addOption(
    new Option('--gzip', 'Create a compressed version of the guide as well')
      .default(false)
      .env('GZIP')
  )
  .addOption(new Option('--curl', 'Display each request as CURL').default(false).env('CURL'))
  .addOption(new Option('--tvheadend-host <host>', 'TVHeadend server host').env('TVHEADEND_HOST'))
  .addOption(new Option('--tvheadend-port <port>', 'TVHeadend server port (default: 9981 for HTTP, 443 for HTTPS)').env('TVHEADEND_PORT'))
  .addOption(new Option('--tvheadend-username <username>', 'TVHeadend username').env('TVHEADEND_USERNAME'))
  .addOption(new Option('--tvheadend-password <password>', 'TVHeadend password').env('TVHEADEND_PASSWORD'))
  .addOption(new Option('--tvheadend-timeout <milliseconds>', 'TVHeadend request timeout').default(30000).env('TVHEADEND_TIMEOUT'))
  .addOption(new Option('--tvheadend-protocol <protocol>', 'TVHeadend protocol (http or https)').default('http').env('TVHEADEND_PROTOCOL'))
  .addOption(new Option('--enable-tvheadend', 'Enable TVHeadend enrichment').default(false).env('ENABLE_TVHEADEND'))
  .parse()

export interface GrabOptions {
  site?: string
  channels?: string
  output: string
  gzip: boolean
  curl: boolean
  maxConnections: number
  timeout?: string
  delay?: string
  lang?: string
  days?: number
  proxy?: string
  tvheadendHost?: string
  tvheadendPort?: number
  tvheadendUsername?: string
  tvheadendPassword?: string
  tvheadendTimeout: number
  tvheadendProtocol: string
  enableTvheadend: boolean
}

const options: GrabOptions = program.opts()

async function main() {
  if (!options.site && !options.channels)
    throw new Error('One of the arguments must be presented: `--site` or `--channels`')

  const logger = new Logger()

  logger.start('starting...')

  logger.info('config:')
  logger.tree(options)

  logger.info('loading channels...')
  const storage = new Storage()
  const parser = new ChannelsParser({ storage })

  let files: string[] = []
  if (options.site) {
    let pattern = path.join(SITES_DIR, options.site, '*.channels.xml')
    pattern = pattern.replace(/\\/g, '/')
    files = await storage.list(pattern)
  } else if (options.channels) {
    files = await storage.list(options.channels)
  }

  let channels = new Collection()
  for (const filepath of files) {
    const channelList: ChannelList = await parser.parse(filepath)

    channels = channels.concat(channelList.channels)
  }

  if (options.lang) {
    channels = channels.filter((channel: Channel) => {
      if (!options.lang || !channel.lang) return true

      return options.lang.includes(channel.lang)
    })
  }

  logger.info(`  found ${channels.count()} channel(s)`)

  logger.info('run:')
  runJob({ logger, channels })
}

main()

async function runJob({ logger, channels }: { logger: Logger; channels: Collection }) {
  const timer = new Timer()
  timer.start()

  const queueCreator = new QueueCreator({
    channels,
    logger,
    options
  })
  const queue = await queueCreator.create()
  const job = new Job({
    queue,
    logger,
    options
  })

  // Run the main EPG grab job to fetch API data but don't create guides yet
  await job.runWithoutGuides()

  // Enrich with TVHeadend data if enabled
  if (options.enableTvheadend && options.tvheadendHost) {
    logger.info('Enriching with TVHeadend data...')
    
    try {
      const tvheadendConfig = {
        host: options.tvheadendHost,
        port: options.tvheadendPort,
        username: options.tvheadendUsername,
        password: options.tvheadendPassword,
        timeout: options.tvheadendTimeout,
        protocol: options.tvheadendProtocol as 'http' | 'https'
      }

      const tvheadendFetcher = new TVHeadendFetcher({
        config: tvheadendConfig,
        logger
      })

      // Test connection first
      const isConnected = await tvheadendFetcher.testConnection()
      if (!isConnected) {
        logger.warn('TVHeadend server is not reachable, skipping enrichment')
      } else {
        // Fetch TVHeadend data
        const tvheadendData = await tvheadendFetcher.fetchXMLTV()
        
        // Merge the data
        const merger = new XMLTVMerger({ logger })
        const mergedData = merger.enrich(
          job.channels,
          job.programs,
          new Collection(tvheadendData.channels),
          new Collection(tvheadendData.programs)
        )

        // Update job data with merged results
        job.channels = mergedData.channels
        job.programs = mergedData.programs

        logger.success('TVHeadend enrichment completed successfully')
      }
    } catch (error) {
      logger.error(`TVHeadend enrichment failed: ${error.message}`)
      logger.info('Continuing with API data only...')
    }
  }

  // Create guides with the final data (API only or enriched)
  logger.info('Creating guides with final data...')
  await job.createGuides()

  logger.success(`  done in ${timer.format('HH[h] mm[m] ss[s]')}`)
}
