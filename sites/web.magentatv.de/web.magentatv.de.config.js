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
    const items = parseItems(content)
    for (const item of items) {
      programs.push({
        title: item.name,
        description: item.introduce,
        images: parseImages(item),
        category: parseCategory(item),
        start: parseStart(item),
        stop: parseStop(item),
        sub_title: item.subName,
        season: item.seasonNum,
        episode: item.subNum,
        directors: parseDirectors(item),
        producers: parseProducers(item),
        adapters: parseAdapters(item),
        actors: parseActors(item),
        country: upperCase(item.country),
        date: item.producedate,
        live: item.isLive === '1',
        urls: parseUrls(item),
        episodeNumbers: await parseEpisodeNumbers(item),
        icon: parseIcon(parseImages(item))
      })
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
  return JSON.parse(item.externalIds)
    .filter(externalId => externalId.type === 'imdb' && externalId.id)
    .map(externalId => ({ system: 'imdb', value: `https://www.imdb.com/title/${externalId.id}` }))
}

async function parseEpisodeNumbers(item) {
  // currently only a imdb id is returned by the api, thus we can construct the episode number field for the series
  if (!item.externalIds) return []
  let episodeNumbers = []
  for (const externalId of JSON.parse(item.externalIds).filter(externalId => externalId.type === 'imdb' && externalId.id)){
      const tmdbSeriesId = await getTMDBSeriesId(externalId.id)
      const tmdbEpisodeId = (tmdbSeriesId && item.seasonNum && item.subNum) ? await getTMDBEpisodeId(tmdbSeriesId, item.seasonNum, item.subNum) : null
      episodeNumbers.push(
        [
          { system: 'xmltv_ns', value: (item.subNum && item.seasonNum) ? `${Number(item.seasonNum) - 1}.${Number(item.subNum) - 1}` : null},
          { system: 'imdb.com', value: `series/${externalId.id}` },
          { system: 'themoviedb.org', value: tmdbSeriesId ? `series/${tmdbSeriesId}` : null },
          { system: 'themoviedb.org', value: tmdbEpisodeId ? `episode/${tmdbEpisodeId}` : null }
        ])
    };
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
  if (imdbIdTmdbMap.get(imdbId)) {
    return imdbIdTmdbMap.get(imdbId)
  }
  const options = {
    method: 'GET',
    url: `https://api.themoviedb.org/3/find/${imdbId}?external_source=imdb_id`,
    headers: {
      accept: 'application/json',
      Authorization: `Bearer ${tmdbBearer}`
    }
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
    console.log('no results found for imdbId: ' + imdbId)
  }
  return imdbIdTmdbMap.get(imdbId)
}

let tmdbEpisodeIdMap = new Map()
async function getTMDBEpisodeId(tmdbId, seasonNum, episodeNum) {
  if (tmdbEpisodeIdMap.get(`${tmdbId}${seasonNum}${episodeNum}`)) {
    return tmdbEpisodeIdMap.get(`${tmdbId}${seasonNum}${episodeNum}`)
  }
  const options = {
    method: 'GET',
    url: `https://api.themoviedb.org/3/tv/${tmdbId}/season/${seasonNum}/episode/${episodeNum}`,
    headers: {
      accept: 'application/json',
      Authorization: `Bearer ${tmdbBearer}`
    }
  }
  
  const res = await axios.request(options)
  tmdbEpisodeIdMap.set(`${tmdbId}${seasonNum}${episodeNum}`, res.data.id)
  return tmdbEpisodeIdMap.get(`${tmdbId}${seasonNum}${episodeNum}`)
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

async function fetchCookieAndToken() {
  // Only fetch the cookies and csrfToken if they are not already set
  if (X_CSRFTOKEN && Cookie) {
    return
  }

  try {
    const response = await axios.request({
      url: 'https://api.prod.sngtv.magentatv.de/EPG/JSON/Authenticate',
      params: {
        SID: 'firstup',
        T: 'Windows_chrome_118'
      },
      method: 'POST',
      data: '{"terminalid":"00:00:00:00:00:00","mac":"00:00:00:00:00:00","terminaltype":"WEBTV","utcEnable":1,"timezone":"Etc/GMT0","userType":3,"terminalvendor":"Unknown"}',
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
