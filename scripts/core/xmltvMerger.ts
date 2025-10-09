import { Collection, Logger } from '@freearhey/core'
import { Program, Channel } from 'epg-grabber'

interface XMLTVMergerProps {
  logger: Logger
}

export class XMLTVMerger {
  private logger: Logger

  constructor({ logger }: XMLTVMergerProps) {
    this.logger = logger
  }

  /**
   * Merge TVHeadend data into API data, with API data taking priority
   * @param apiChannels Channels from the primary API
   * @param apiPrograms Programs from the primary API
   * @param tvheadendChannels Channels from TVHeadend
   * @param tvheadendPrograms Programs from TVHeadend
   * @returns Merged channels and programs
   */
  merge(
    apiChannels: Collection,
    apiPrograms: Collection,
    tvheadendChannels: Collection,
    tvheadendPrograms: Collection
  ): { channels: Collection; programs: Collection } {
    
    this.logger.info('Starting XMLTV merge process...')
    
    // Start with API channels as base - clone the existing collections
    const mergedChannels = new Collection(apiChannels.all())
    const mergedPrograms = new Collection(apiPrograms.all())
    
    // Track which channels already exist from API
    const existingChannelIds = new Set()
    for (const channel of apiChannels.all()) {
      if (channel.xmltv_id) {
        existingChannelIds.add(channel.xmltv_id)
      }
    }
    
    // Add TVHeadend channels that don't exist in API data
    let addedChannels = 0
    for (const channel of tvheadendChannels.all()) {
      if (channel.xmltv_id && !existingChannelIds.has(channel.xmltv_id)) {
        mergedChannels.add(channel)
        addedChannels++
      }
    }
    
    this.logger.info(`Added ${addedChannels} channels from TVHeadend`)
    
    // Track existing programs by channel and time slot
    const existingPrograms = new Map<string, Set<string>>()
    for (const program of apiPrograms.all()) {
      const key = `${program.channel}:${program.start}:${program.stop}`
      if (!existingPrograms.has(program.channel)) {
        existingPrograms.set(program.channel, new Set())
      }
      existingPrograms.get(program.channel)!.add(key)
    }
    
    // Add TVHeadend programs that don't conflict with API programs
    let addedPrograms = 0
    for (const program of tvheadendPrograms.all()) {
      const key = `${program.channel}:${program.start}:${program.stop}`
      const channelPrograms = existingPrograms.get(program.channel)
      
      if (!channelPrograms || !channelPrograms.has(key)) {
        mergedPrograms.add(program)
        addedPrograms++
        
        // Track this program to avoid duplicates within TVHeadend data
        if (!channelPrograms) {
          existingPrograms.set(program.channel, new Set())
        }
        existingPrograms.get(program.channel)!.add(key)
      }
    }
    
    this.logger.info(`Added ${addedPrograms} programs from TVHeadend`)
    this.logger.info(`Final result: ${mergedChannels.count()} channels, ${mergedPrograms.count()} programs`)
    
    return {
      channels: mergedChannels,
      programs: mergedPrograms
    }
  }

  /**
   * Enrich API programs with TVHeadend data where API data is missing
   * This is a more sophisticated merge that fills gaps in API data
   */
  enrich(
    apiChannels: Collection,
    apiPrograms: Collection,
    tvheadendChannels: Collection,
    tvheadendPrograms: Collection
  ): { channels: Collection; programs: Collection } {
    
    this.logger.info('Starting XMLTV enrichment process...')
    
    // Debug: Log collection types and sizes
    this.logger.info('Collection debug info:', {
      apiChannelsType: typeof apiChannels,
      apiChannelsCount: apiChannels.count(),
      apiProgramsType: typeof apiPrograms,
      apiProgramsCount: apiPrograms.count(),
      tvheadendChannelsType: typeof tvheadendChannels,
      tvheadendChannelsCount: tvheadendChannels.count(),
      tvheadendProgramsType: typeof tvheadendPrograms,
      tvheadendProgramsCount: tvheadendPrograms.count()
    })
    
    // Start with API data - clone the existing collections
    const enrichedChannels = new Collection(apiChannels.all())
    const enrichedPrograms = new Collection(apiPrograms.all())
    
    // Create lookup maps for efficient searching
    const apiChannelMap = new Map()
    for (const channel of apiChannels.all()) {
      if (channel.xmltv_id) {
        apiChannelMap.set(channel.xmltv_id, channel)
      }
    }
    
    const apiProgramMap = new Map<string, Program[]>()
    for (const program of apiPrograms.all()) {
      if (!apiProgramMap.has(program.channel)) {
        apiProgramMap.set(program.channel, [])
      }
      apiProgramMap.get(program.channel)!.push(program)
    }
    
    // Add missing channels from TVHeadend
    let addedChannels = 0
    for (const channel of tvheadendChannels.all()) {
      if (channel.xmltv_id && !apiChannelMap.has(channel.xmltv_id)) {
        enrichedChannels.add(channel)
        addedChannels++
      }
    }
    
    // Add programs for channels that have no API data
    let addedPrograms = 0
    for (const program of tvheadendPrograms.all()) {
      const apiProgramsForChannel = apiProgramMap.get(program.channel) || []
      
      // If no API programs exist for this channel, add all TVHeadend programs
      if (apiProgramsForChannel.length === 0) {
        enrichedPrograms.add(program)
        addedPrograms++
      } else {
        // Check if this time slot is covered by API data
        const hasOverlap = apiProgramsForChannel.some(apiProgram => 
          this.programsOverlap(apiProgram, program)
        )
        
        if (!hasOverlap) {
          enrichedPrograms.add(program)
          addedPrograms++
        }
      }
    }
    
    this.logger.info(`Enriched with ${addedChannels} channels and ${addedPrograms} programs from TVHeadend`)
    this.logger.info(`Final result: ${enrichedChannels.count()} channels, ${enrichedPrograms.count()} programs`)
    
    return {
      channels: enrichedChannels,
      programs: enrichedPrograms
    }
  }

  /**
   * Check if two programs overlap in time
   */
  private programsOverlap(program1: Program, program2: Program): boolean {
    const start1 = new Date(program1.start)
    const stop1 = new Date(program1.stop)
    const start2 = new Date(program2.start)
    const stop2 = new Date(program2.stop)
    
    return start1 < stop2 && start2 < stop1
  }
}
