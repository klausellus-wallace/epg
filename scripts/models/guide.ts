import { Collection, DateTime } from '@freearhey/core'
import { generateXMLTV } from 'epg-grabber'

interface GuideData {
  channels: Collection
  programs: Collection
  filepath: string
  gzip: boolean
}

export class Guide {
  channels: Collection
  programs: Collection
  filepath: string
  gzip: boolean

  constructor({ channels, programs, filepath, gzip }: GuideData) {
    this.channels = channels
    this.programs = programs
    this.filepath = filepath
    this.gzip = gzip || false
  }

  toString() {
    const currDate = new DateTime(process.env.CURR_DATE || new Date().toISOString(), {
      timezone: 'UTC'
    })

    return generateXMLTV({
      channels: Array.from(this.channels.all()),
      programs: Array.from(this.programs.all()),
      date: currDate.toJSON()
    })
  }
}
