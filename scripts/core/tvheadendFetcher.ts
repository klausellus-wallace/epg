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
    this.baseUrl = `http://${config.host}:${config.port}`
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
      
      // Extract channels and programs from the parsed data
      const channels = parsed.channels || []
      const programs = parsed.programs || []
      
      this.logger.info(`Parsed ${channels.length} channels and ${programs.length} programs from TVHeadend`)
      
      return {
        channels,
        programs
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
