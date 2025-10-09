import axios, { AxiosResponse } from 'axios'
import { Logger } from '@freearhey/core'
import * as parser from 'epg-parser'
import { Program, Channel } from 'epg-grabber'

interface TVHeadendConfig {
  host: string
  port: number
  username?: string
  password?: string
  timeout?: number
  protocol?: 'http' | 'https'
}

interface TVHeadendFetcherProps {
  config: TVHeadendConfig
  logger: Logger
}

export class TVHeadendFetcher {
  private config: TVHeadendConfig
  private logger: Logger
  private baseUrl: string

  constructor({ config, logger }: TVHeadendFetcherProps) {
    this.config = config
    this.logger = logger
    const protocol = config.protocol || 'http'
    
    // Use default ports if not specified
    let port = config.port
    if (!port) {
      port = protocol === 'https' ? 443 : 9981
    }
    
    this.baseUrl = `${protocol}://${config.host}:${port}`
  }

  /**
   * Fetch XMLTV data from TVHeadend server
   */
  async fetchXMLTV(): Promise<{ channels: Channel[]; programs: Program[] }> {
    try {
      this.logger.info('Fetching XMLTV data from TVHeadend...')
      
      const xmltvUrl = `${this.baseUrl}/xmltv/channels`
      const response: AxiosResponse<string> = await axios.get(xmltvUrl, {
        timeout: this.config.timeout || 30000,
        auth: this.config.username && this.config.password 
          ? { username: this.config.username, password: this.config.password }
          : undefined,
        headers: {
          'Accept': 'application/xml',
          'User-Agent': 'EPG-Docker/1.0'
        }
      })

      if (response.status !== 200) {
        throw new Error(`TVHeadend returned status ${response.status}`)
      }

      this.logger.info(`Successfully fetched XMLTV data (${response.data.length} bytes)`)
      
      // Parse the XMLTV data
      const parsed = parser.parse(response.data)
      
      // Debug: Log the structure of parsed data
      this.logger.info(`Parsed data structure:`, {
        hasChannels: !!parsed.channels,
        hasPrograms: !!parsed.programs,
        channelsType: typeof parsed.channels,
        programsType: typeof parsed.programs,
        channelsLength: Array.isArray(parsed.channels) ? parsed.channels.length : 'not array',
        programsLength: Array.isArray(parsed.programs) ? parsed.programs.length : 'not array'
      })
      
      // Extract channels and programs from the parsed data
      // epg-parser returns objects, not arrays, so we need to convert them
      const channels = Array.isArray(parsed.channels) ? parsed.channels : Object.values(parsed.channels || {})
      const programs = Array.isArray(parsed.programs) ? parsed.programs : Object.values(parsed.programs || {})
      
      // Convert plain objects to Program instances
      const programInstances = programs.map(programData => {
        // Ensure the channel property is set
        const channelId = programData.channel || 'unknown'
        
        // Find the corresponding channel for this program
        const channelData = channels.find(ch => ch.id === channelId)
        if (!channelData) {
          // Create a dummy channel if not found
          const dummyChannel = new Channel({ 
            id: channelId, 
            name: channelId 
          })
          const program = new Program({ ...programData, channel: channelId }, dummyChannel)
          program.channel = channelId  // Explicitly set the channel property
          return program
        }
        
        // Create channel instance
        const channelInstance = new Channel(channelData)
        const program = new Program({ ...programData, channel: channelId }, channelInstance)
        program.channel = channelId  // Explicitly set the channel property
        return program
      })
      
      this.logger.info(`Parsed ${channels.length} channels and ${programInstances.length} programs from TVHeadend`)
      
      return {
        channels: channels.map(channelData => new Channel(channelData)),
        programs: programInstances
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      this.logger.error(`Failed to fetch XMLTV from TVHeadend: ${errorMessage}`)
      throw error
    }
  }

  /**
   * Test connection to TVHeadend server
   */
  async testConnection(): Promise<boolean> {
    try {
      const testUrl = `${this.baseUrl}/api/serverinfo`
      await axios.get(testUrl, {
        timeout: 5000,
        auth: this.config.username && this.config.password 
          ? { username: this.config.username, password: this.config.password }
          : undefined
      })
      return true
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      this.logger.warn(`TVHeadend connection test failed: ${errorMessage}`)
      return false
    }
  }
}
