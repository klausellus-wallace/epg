const axios = require('axios')
const dayjs = require('dayjs')
const utc = require('dayjs/plugin/utc')
const customParseFormat = require('dayjs/plugin/customParseFormat')
const { upperCase } = require('lodash')

let X_CSRFTOKEN
let Cookie
const cookiesToExtract = ['JSESSIONID', 'CSESSIONID', 'CSRFSESSION']

// TMDB API Key
const tmdbBearer = process.env.TMDBBEARER

dayjs.extend(utc)
dayjs.extend(customParseFormat)

module.exports = {
  site: 'web.magentatv.de',
  days: 2,
  url: 'https://api.prod.sngtv.magentatv.de/EPG/JSON/PlayBillList',
  request: {
    method: 'POST',
    async headers() {
      return await setHeaders()
    },
    data({ channel, date }) {
      return {
        count: -1,
        isFillProgram: 1,
        offset: 0,
        properties: [
          {
            include:
              'endtime,genres,id,name,starttime,channelid,pictures,introduce,subName,seasonNum,subNum,cast,country,producedate,externalIds',
            name: 'playbill'
          }
        ],
        type: 2,
        begintime: date.format('YYYYMMDD000000'),
        channelid: channel.site_id,
        endtime: date.add(1, 'd').format('YYYYMMDD000000')
      }
    }
  },
  async parser({ content }) {
    const programs = []
    try {
      const items = parseItems(content)
      for (const item of items) {
        const images = parseImages(item)
        const urls = parseUrls(item)
        const episodeNumbers = await parseEpisodeNumbers(item)
        
        // Validate and clean enriched data for Jellyfin compatibility
        const program = {
          title: item.name || 'Unknown Title',
          description: item.introduce || '',
          images: images || [],
          category: parseCategory(item) || [],
          start: parseStart(item),
          stop: parseStop(item),
          sub_title: item.subName || null,
          season: item.seasonNum || null,
          episode: item.subNum || null,
          directors: parseDirectors(item) || [],
          producers: parseProducers(item) || [],
          adapters: parseAdapters(item) || [],
          actors: parseActors(item) || [],
          country: item.country ? upperCase(item.country) : null,
          date: item.producedate || null,
          live: item.isLive === '1',
          urls: urls || [],
          episodeNumbers: episodeNumbers || [],
          icon: parseIcon(images)
        }
        
        // Ensure episodeNumbers and urls are arrays for XMLTV compatibility
        if (!Array.isArray(program.episodeNumbers)) {
          program.episodeNumbers = []
        }
        if (!Array.isArray(program.urls)) {
          program.urls = []
        }
        
        programs.push(program)
      }
      if (programs.length === 0) {
        console.log('No programs found')
      }
    } catch (error) {
      console.error('Error parsing programs:', error.message)
    }
    return programs
  },
  async channels() {
    const url = 'https://api.prod.sngtv.magentatv.de/EPG/JSON/AllChannel'
    const body = {
      channelNamespace: 2,
      filterlist: [
        {
          key: 'IsHide',
          value: '-1'
        }
      ],
      metaDataVer: 'Channel/1.1',
      properties: [
        {
          include: '/channellist/logicalChannel/contentId,/channellist/logicalChannel/name',
          name: 'logicalChannel'
        }
      ],
      returnSatChannel: 0
    }
    const params = {
      headers: await setHeaders()
    }

    const data = await axios
      .post(url, body, params)
      .then(r => r.data)
      .catch(console.log)

    return data.channellist.map(item => {
      return {
        lang: 'de',
        site_id: item.contentId,
        name: item.name
      }
    })
  }
}

function parseCategory(item) {
  const isMovie = JSON.parse(item.externalIds).filter(externalId => externalId.type === 'gnProgram' && externalId.id)[0]?.id.startsWith('MV')
  const genres = item.genres
    ? item.genres
        .replace('und', ',')
        .split(',')
        .map(i => i.trim())
    : []
  if (isMovie) {
    genres.push('movie')
  }
  return genres
}

function parseDirectors(item) {
  if (!item.cast || !item.cast.director) return []
  return item.cast.director
    .replace('und', ',')
    .split(',')
    .map(i => i.trim())
}

function parseProducers(item) {
  if (!item.cast || !item.cast.producer) return []
  return item.cast.producer
    .replace('und', ',')
    .split(',')
    .map(i => i.trim())
}

function parseAdapters(item) {
  if (!item.cast || !item.cast.adaptor) return []
  return item.cast.adaptor
    .replace('und', ',')
    .split(',')
    .map(i => i.trim())
}

function parseActors(item) {
  // TODO: get roles from fclist
  // cast.castCode': 'gnp_1650' -> fclist.actorID
  // 
  if (!item.cast || !item.cast.actor) return []
  return item.cast.actor
    .replace('und', ',')
    .split(',')
    .map(i => i.trim())
}

function parseUrls(item) {
  // currently only a imdb id is returned by the api, thus we can construct the url here
  if (!item.externalIds) return []
  try {
    return JSON.parse(item.externalIds)
      .filter(externalId => externalId.type === 'imdb' && externalId.id)
      .map(externalId => ({ 
        system: 'imdb.com', 
        value: `https://www.imdb.com/title/${externalId.id}` 
      }))
  } catch (error) {
    console.error('Error parsing externalIds for URLs:', error.message)
    return []
  }
}

async function parseEpisodeNumbers(item) {
  // currently only a imdb id is returned by the api, thus we can construct the episode number field for the series
  if (!item.externalIds) return []
  let episodeNumbers = []

  try {
    const externalIds = JSON.parse(item.externalIds)
    
    for (const externalId of externalIds.filter(externalId => externalId.type === 'imdb' && externalId.id)) {
      const tmdbSeriesId = await getTMDBSeriesId(externalId.id)
      const tmdbEpisodeId = (tmdbSeriesId && item.seasonNum && item.subNum)
        ? await getTMDBEpisodeId(tmdbSeriesId, item.seasonNum, item.subNum)
        : null

      const values = [
        // XMLTV NS format: season.episode. (0-based indexing)
        (item.subNum && item.seasonNum)
          ? { system: 'xmltv_ns', value: `${Number(item.seasonNum) - 1}.${Number(item.subNum) - 1}.` }
          : null,
        // IMDB series ID
        { system: 'imdb.com', value: `series/${externalId.id}` },
        // TMDB series ID
        tmdbSeriesId ? { system: 'themoviedb.org', value: `series/${tmdbSeriesId}` } : null,
        // TMDB episode ID
        tmdbEpisodeId ? { system: 'themoviedb.org', value: `episode/${tmdbEpisodeId}` } : null
      ]

      episodeNumbers.push(values.filter(Boolean))
    }
  } catch (error) {
    console.error('Error parsing episodeNumbers:', error.message)
    return []
  }

  return episodeNumbers.flat()
}

function parseImages(item) {
  if (!Array.isArray(item.pictures) || !item.pictures.length) return null

  return item.pictures
    .filter((image) => image.imageType === '17' || image.imageType === '18') // imageType 17 => Posters in widescreen; imageType 18 => Poster w/ title
      .map((picture) => {
      return {
        type: 'poster',
        value: picture.href.replace('http://', 'https://')
      }
    }
  )
}

let imdbIdTmdbMap = new Map()

async function getTMDBSeriesId(imdbId) {
  if (!imdbId || !tmdbBearer) {
    console.log('Missing imdbId or TMDB bearer token')
    return null
  }

  if (imdbIdTmdbMap.get(imdbId)) {
    return imdbIdTmdbMap.get(imdbId)
  }

  try {
    const options = {
      method: 'GET',
      url: `https://api.themoviedb.org/3/find/${imdbId}?external_source=imdb_id`,
      headers: {
        accept: 'application/json',
        Authorization: `Bearer ${tmdbBearer}`
      },
      timeout: 10000 // 10 second timeout
    }
    
    const res = await axios.request(options)
    
    if (res.data.tv_results?.length > 0 && res.data.tv_results[0].id) {
      imdbIdTmdbMap.set(imdbId, res.data.tv_results[0].id)
    } else if (res.data.tv_episode_results?.length > 0 && res.data.tv_episode_results[0].id) {
      imdbIdTmdbMap.set(imdbId, res.data.tv_episode_results[0].id)
    } else if (res.data.tv_season_results?.length > 0 && res.data.tv_season_results[0].id) {
      imdbIdTmdbMap.set(imdbId, res.data.tv_season_results[0].id)
    } else if (res.data.movie_results?.length > 0 && res.data.movie_results[0].id) {
      imdbIdTmdbMap.set(imdbId, res.data.movie_results[0].id)
    } else {
      console.log('No TMDB results found for imdbId:', imdbId)
      imdbIdTmdbMap.set(imdbId, null) // Cache negative result
    }
  } catch (error) {
    console.error('Error fetching TMDB series ID for imdbId:', imdbId, error.message)
    imdbIdTmdbMap.set(imdbId, null) // Cache negative result
  }
  
  return imdbIdTmdbMap.get(imdbId)
}

let tmdbEpisodeIdMap = new Map()
async function getTMDBEpisodeId(tmdbId, seasonNum, episodeNum) {
  if (!tmdbId || !seasonNum || !episodeNum || !tmdbBearer) {
    console.log('Missing required parameters for TMDB episode lookup')
    return null
  }

  const cacheKey = `${tmdbId}${seasonNum}${episodeNum}`
  if (tmdbEpisodeIdMap.get(cacheKey)) {
    return tmdbEpisodeIdMap.get(cacheKey)
  }

  try {
    const options = {
      method: 'GET',
      url: `https://api.themoviedb.org/3/tv/${tmdbId}/season/${seasonNum}/episode/${episodeNum}`,
      headers: {
        accept: 'application/json',
        Authorization: `Bearer ${tmdbBearer}`
      },
      timeout: 10000 // 10 second timeout
    }
    
    const res = await axios.request(options)
    
    if (res.data && res.data.id) {
      tmdbEpisodeIdMap.set(cacheKey, res.data.id)
    } else {
      console.log('No TMDB episode ID found for:', { tmdbId, seasonNum, episodeNum })
      tmdbEpisodeIdMap.set(cacheKey, null) // Cache negative result
    }
  } catch (error) {
    console.error('Error fetching TMDB episode ID:', error.message)
    tmdbEpisodeIdMap.set(cacheKey, null) // Cache negative result
  }
  
  return tmdbEpisodeIdMap.get(cacheKey)
}

function parseIcon(images) {
  return images && images.length ? images[0].value : null
}

function parseStart(item) {
  return dayjs.utc(item.starttime, 'YYYY-MM-DD HH:mm:ss')
}

function parseStop(item) {
  return dayjs.utc(item.endtime, 'YYYY-MM-DD HH:mm:ss')
}

function parseItems(content) {
  const data = JSON.parse(content)
  if (!data || !Array.isArray(data.playbilllist)) return []

  return data.playbilllist
}

function genMAC(){
  var hexDigits = '0123456789ABCDEF'
  var macAddress = ''
  for (var i = 0; i < 6; i++) {
      macAddress+=hexDigits.charAt(Math.round(Math.random() * 15))
      macAddress+=hexDigits.charAt(Math.round(Math.random() * 15))
      if (i != 5) macAddress += ':'
  }

  return macAddress
}

async function fetchCookieAndToken() {
  // Only fetch the cookies and csrfToken if they are not already set
  if (X_CSRFTOKEN && Cookie) {
    return
  }

  try {
    const mac = genMAC()
    const response = await axios.request({
      url: 'https://api.prod.sngtv.magentatv.de/EPG/JSON/Authenticate',
      params: {
        SID: 'firstup',
        T: 'Windows_chrome_118'
      },
      method: 'POST',
      data: `{"terminalid":"${mac}","mac":"${mac}","terminaltype":"WEBTV","utcEnable":1,"timezone":"Etc/GMT0","userType":3,"terminalvendor":"Unknown"}`,
    })

    // Extract the cookies specified in cookiesToExtract
    const setCookieHeader = response.headers['set-cookie'] || []
    const extractedCookies = []
    cookiesToExtract.forEach(cookieName => {
      const regex = new RegExp(`${cookieName}=(.+?)(;|$)`)
      const match = setCookieHeader.find(header => regex.test(header))

      if (match) {
        const cookieString = regex.exec(match)[0]
        extractedCookies.push(cookieString)
      }
    })

    // check if we recieved a csrfToken only then store the values
    if (!response.data.csrfToken) {
      console.log('csrfToken not found in the response.')
      return
    }

    X_CSRFTOKEN = response.data.csrfToken
    Cookie = extractedCookies.join(' ')

  } catch(error) {
    console.error(error)
  }
}

async function setHeaders() {
  await fetchCookieAndToken()

  return { X_CSRFTOKEN, Cookie }
}
