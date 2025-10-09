import { Logger, Collection } from '@freearhey/core'
import { Queue, Grabber, GuideManager } from '.'
import { GrabOptions } from '../commands/epg/grab'

interface JobProps {
  options: GrabOptions
  logger: Logger
  queue: Queue
}

export class Job {
  options: GrabOptions
  logger: Logger
  grabber: Grabber
  channels: Collection
  programs: Collection

  constructor({ queue, logger, options }: JobProps) {
    this.options = options
    this.logger = logger
    this.grabber = new Grabber({ logger, queue, options })
    this.channels = new Collection()
    this.programs = new Collection()
  }

  async run() {
    const { channels, programs } = await this.grabber.grab()
    
    // Store the data for potential enrichment
    this.channels = channels
    this.programs = programs

    await this.createGuides()
  }

  async createGuides() {
    const manager = new GuideManager({
      channels: this.channels,
      programs: this.programs,
      options: this.options,
      logger: this.logger
    })

    await manager.createGuides()
  }
}
