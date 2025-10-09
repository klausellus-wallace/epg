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

// Throttling configuration
const THROTTLING_CONFIG = {
  requestDelay: 500 // 500ms delay between requests
}

// Request tracking for adaptive delays
let requestTracker = {
  recentRequests: [],
  successCount: 0,
  failureCount: 0
}

dayjs.extend(utc)
dayjs.extend(customParseFormat)

// Utility functions for throttling and retry logic
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function recordRequestSuccess() {
  requestTracker.successCount++
  requestTracker.recentRequests.push({ timestamp: Date.now(), success: true })
  
  // Keep only last 10 requests for tracking
  if (requestTracker.recentRequests.length > 10) {
    requestTracker.recentRequests = requestTracker.recentRequests.slice(-10)
  }
}

function recordRequestFailure() {
  requestTracker.failureCount++
  requestTracker.recentRequests.push({ timestamp: Date.now(), success: false })
  
  // Keep only last 10 requests for tracking
  if (requestTracker.recentRequests.length > 10) {
    requestTracker.recentRequests = requestTracker.recentRequests.slice(-10)
  }
}

function calculateAdaptiveDelay() {
  const now = Date.now()
  const recentRequests = requestTracker.recentRequests.filter(
    req => now - req.timestamp < 60000 // Last minute
  )
  
  const recentFailures = recentRequests.filter(req => !req.success).length
  const recentSuccesses = recentRequests.filter(req => req.success).length
  
  // If we have recent failures, increase delay
  if (recentFailures > 0) {
    const failureRate = recentFailures / (recentFailures + recentSuccesses)
    return THROTTLING_CONFIG.requestDelay * (1 + failureRate * 2)
  }
  
  // If we have many recent successes, we can reduce delay slightly
  if (recentSuccesses > 5) {
    return Math.max(THROTTLING_CONFIG.requestDelay * 0.5, 200)
  }
  
  return THROTTLING_CONFIG.requestDelay
}


module.exports = {
  site: 'web.magentatv.de',
  days: 2,
  url: 'https://api.prod.sngtv.magentatv.de/EPG/JSON/PlayBillList',
  // Dynamic delay based on throttling state
  get delay() {
    return calculateAdaptiveDelay()
  },
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
  async parser({ content, channel, date }) {
    const programs = []
    try {
      const items = parseItems(content)
      
      // Check for throttling (empty program list)
      if (items.length === 0) {
        console.warn(`Empty program list for channel ${channel?.site_id} on ${date} - possible throttling`)
        recordRequestFailure()
        
        // If this is a throttled response, we could retry here
        // But since we're in the parser, we'll just return empty and let the delay system handle it
        return programs
      } else {
        recordRequestSuccess()
        console.log(`Successfully parsed ${items.length} programs for channel ${channel?.site_id}`)
      }
      
      for (const item of items) {
        try {
          const images = parseImages(item)
          const urls = parseUrls(item)
          
          // Safely parse episode numbers with fallback
          let episodeNumbers = []
          try {
            episodeNumbers = await parseEpisodeNumbers(item)
          } catch (error) {
            console.warn('Failed to parse episode numbers, using fallback:', error.message)
            // Fallback: create basic episode numbers from original data
            if (item.subNum && item.seasonNum) {
              episodeNumbers = [{
                system: 'xmltv_ns',
                value: `${Number(item.seasonNum) - 1}.${Number(item.subNum) - 1}.`
              }]
            }
          }
          
          // Fetch enhanced TMDB data
          let enhancedData = {}
          try {
            enhancedData = await parseEnhancedTMDBData(item)
          } catch (error) {
            console.warn('Failed to fetch enhanced TMDB data:', error.message)
          }
          
          // Validate and clean enriched data for Jellyfin compatibility
          const program = {
            title: item.name || 'Unknown Title',
            description: enhancedData.description || item.introduce || '',
            images: [...(images || []), ...(enhancedData.images || [])],
            category: [...(parseCategory(item) || []), ...(enhancedData.categories || [])],
            start: parseStart(item),
            stop: parseStop(item),
            subTitle: item.subName || null, // Use subTitle as per epg-grabber docs
            season: item.seasonNum || null,
            episode: item.subNum || null,
            directors: [...(parseDirectors(item) || []), ...(enhancedData.directors || [])],
            producers: parseProducers(item) || [],
            adapters: parseAdapters(item) || [],
            actors: [...(parseActors(item) || []), ...(enhancedData.actors || [])],
            writers: enhancedData.writers || [],
            country: item.country ? upperCase(item.country) : null,
            date: item.producedate || null,
            live: item.isLive === '1',
            urls: urls || [],
            episodeNumber: episodeNumbers || [], // Use episodeNumber as per epg-grabber docs
            rating: enhancedData.rating || null,
            starRatings: enhancedData.starRatings || [],
            keyword: enhancedData.keywords || [],
            icon: enhancedData.icon || parseIcon(images)
          }
          
          // Ensure episodeNumber and urls are arrays for XMLTV compatibility
          if (!Array.isArray(program.episodeNumber)) {
            program.episodeNumber = []
          }
          if (!Array.isArray(program.urls)) {
            program.urls = []
          }
          
          programs.push(program)
        } catch (itemError) {
          console.error('Error processing individual program item, skipping:', itemError.message)
          // Create a minimal program entry to preserve basic data
          try {
            const minimalProgram = {
              title: item.name || 'Unknown Title',
              description: item.introduce || '',
              start: parseStart(item),
              stop: parseStop(item),
              subTitle: item.subName || null, // Use subTitle as per epg-grabber docs
              season: item.seasonNum || null,
              episode: item.subNum || null,
              country: item.country ? upperCase(item.country) : null,
              date: item.producedate || null,
              live: item.isLive === '1',
              images: [],
              category: [],
              directors: [],
              producers: [],
              adapters: [],
              actors: [],
              urls: [],
              episodeNumber: [],
              icon: null
            }
            programs.push(minimalProgram)
          } catch (fallbackError) {
            console.error('Even fallback program creation failed, skipping item completely:', fallbackError.message)
          }
        }
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
    
    const headers = await setHeaders()
    const params = {
      headers
    }

    try {
      // Add adaptive delay before channels request
      const delay = calculateAdaptiveDelay()
      if (delay > 0) {
        console.log(`Adding ${delay}ms delay before channels request`)
        await sleep(delay)
      }
      
      const data = await axios
        .post(url, body, params)
        .then(r => r.data)
        .catch(error => {
          console.error('Failed to fetch channels:', error.message)
          recordRequestFailure()
          return { channellist: [] }
        })
      
      if (!data || !data.channellist || data.channellist.length === 0) {
        console.warn('No channel data received from API')
        recordRequestFailure()
        return []
      }
      
      recordRequestSuccess()
      console.log(`Successfully fetched ${data.channellist.length} channels`)
      
      return data.channellist.map(item => {
        return {
          lang: 'de',
          site_id: item.contentId,
          name: item.name
        }
      })
    } catch (error) {
      console.error('Failed to fetch channels:', error.message)
      recordRequestFailure()
      return []
    }
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
      // Always include original data first to ensure it's never lost
      const baseValues = [
        // XMLTV NS format: season.episode. (0-based indexing) - always preserve original data
        (item.subNum && item.seasonNum)
          ? { system: 'xmltv_ns', value: `${Number(item.seasonNum) - 1}.${Number(item.subNum) - 1}.` }
          : null,
        // IMDB series ID - always preserve original data
        { system: 'imdb.com', value: `series/${externalId.id}` }
      ]

      // Try to enrich with TMDB data, but don't fail if it doesn't work
      let tmdbValues = []
      try {
        const tmdbSeriesId = await getTMDBSeriesId(externalId.id)
        const tmdbEpisodeId = (tmdbSeriesId && item.seasonNum && item.subNum)
          ? await getTMDBEpisodeId(tmdbSeriesId, item.seasonNum, item.subNum)
          : null

        tmdbValues = [
          // TMDB series ID
          tmdbSeriesId ? { system: 'themoviedb.org', value: `series/${tmdbSeriesId}` } : null,
          // TMDB episode ID
          tmdbEpisodeId ? { system: 'themoviedb.org', value: `episode/${tmdbEpisodeId}` } : null
        ].filter(Boolean)
      } catch (tmdbError) {
        console.warn('TMDB enrichment failed for episodeNumbers, preserving original data:', tmdbError.message)
        // Continue with original data only
      }

      // Combine base values with TMDB enrichment (if successful)
      const allValues = [...baseValues.filter(Boolean), ...tmdbValues]
      episodeNumbers.push(allValues)
    }
  } catch (error) {
    console.error('Error parsing episodeNumbers:', error.message)
    // Return empty array only if we can't parse externalIds at all
    return []
  }

  return episodeNumbers.flat()
}

async function parseEnhancedTMDBData(item) {
  if (!item.externalIds) return {}
  
  try {
    const externalIds = JSON.parse(item.externalIds)
    const imdbId = externalIds.find(externalId => externalId.type === 'imdb' && externalId.id)?.id
    
    if (!imdbId || !item.seasonNum || !item.subNum) return {}
    
    const tmdbSeriesId = await getTMDBSeriesId(imdbId)
    if (!tmdbSeriesId) return {}
    
    // Fetch enhanced data in parallel
    const [episodeDetails, seriesDetails] = await Promise.all([
      getTMDBEpisodeDetails(tmdbSeriesId, item.seasonNum, item.subNum),
      getTMDBSeriesDetails(tmdbSeriesId)
    ])
    
    const enhancedData = {}
    
    // Enhanced description from TMDB episode overview (prefer German, fallback to English)
    if (episodeDetails?.overview) {
      enhancedData.description = episodeDetails.overview
    } else if (episodeDetails?.overview === '' && item.introduce) {
      // If TMDB German overview is empty, keep original German description
      enhancedData.description = item.introduce
    }
    
    // Enhanced categories from TMDB genres
    if (episodeDetails?.genres || seriesDetails?.genres) {
      const genres = [...(episodeDetails?.genres || []), ...(seriesDetails?.genres || [])]
      enhancedData.categories = [...new Set(genres.map(g => g.name))]
    }
    
    // Enhanced cast from TMDB guest stars and crew
    if (episodeDetails?.guest_stars || episodeDetails?.crew) {
      enhancedData.actors = [
        ...(episodeDetails.guest_stars || []).map(star => star.name),
        ...(episodeDetails.crew || []).filter(person => person.job === 'Actor').map(person => person.name)
      ]
    }
    
    // Enhanced directors from TMDB crew
    if (episodeDetails?.crew) {
      enhancedData.directors = episodeDetails.crew
        .filter(person => person.job === 'Director')
        .map(person => person.name)
    }
    
    // Enhanced writers from TMDB crew
    if (episodeDetails?.crew) {
      enhancedData.writers = episodeDetails.crew
        .filter(person => ['Writer', 'Screenplay', 'Story'].includes(person.job))
        .map(person => person.name)
    }
    
    // Enhanced images from TMDB stills and backdrops
    if (episodeDetails?.still_path) {
      enhancedData.images = [
        ...(enhancedData.images || []),
        {
          type: 'still',
          value: `https://image.tmdb.org/t/p/original${episodeDetails.still_path}`
        }
      ]
    }
    
    // Enhanced backdrop from series details
    if (seriesDetails?.backdrop_path) {
      enhancedData.images = [
        ...(enhancedData.images || []),
        {
          type: 'backdrop',
          value: `https://image.tmdb.org/t/p/original${seriesDetails.backdrop_path}`
        }
      ]
    }
    
    // Set primary icon (first poster or still for thumbnail)
    if (enhancedData.images && enhancedData.images.length > 0) {
      enhancedData.icon = enhancedData.images.find(img => img.type === 'poster')?.value || 
                         enhancedData.images.find(img => img.type === 'still')?.value ||
                         enhancedData.images[0].value
    }
    
    // Enhanced content ratings from TMDB (age restrictions/certifications)
    // Note: TMDB doesn't provide content ratings for individual episodes,
    // only for series. We'll fetch series content ratings if available.
    if (seriesDetails?.content_ratings?.results) {
      // Look for German (DE) content rating first, then US, then any available
      const germanRating = seriesDetails.content_ratings.results.find(rating => rating.iso_3166_1 === 'DE')
      const usRating = seriesDetails.content_ratings.results.find(rating => rating.iso_3166_1 === 'US')
      const anyRating = seriesDetails.content_ratings.results[0]
      
      const selectedRating = germanRating || usRating || anyRating
      
      if (selectedRating && selectedRating.rating) {
        enhancedData.rating = {
          system: selectedRating.iso_3166_1 === 'DE' ? 'FSK' : 
                 selectedRating.iso_3166_1 === 'US' ? 'MPAA' : 
                 'themoviedb.org',
          value: selectedRating.rating
        }
      }
    }
    
    // Enhanced star ratings (user ratings/vote averages)
    if (episodeDetails?.vote_average && episodeDetails?.vote_count > 10) {
      const stars = Math.round(episodeDetails.vote_average / 2) // Convert 10-point scale to 5-star scale
      enhancedData.starRatings = [
        {
          system: 'themoviedb.org',
          value: `${stars}/5`
        }
      ]
    }
    
    // Enhanced keywords from series
    if (seriesDetails?.keywords?.results) {
      enhancedData.keywords = seriesDetails.keywords.results.map(keyword => keyword.name)
    }
    
    return enhancedData
    
  } catch (error) {
    console.warn('Error fetching enhanced TMDB data:', error.message)
    return {}
  }
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

  // Check cache first
  const cached = imdbIdTmdbMap.get(imdbId)
  if (cached !== undefined) {
    return cached
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
      imdbIdTmdbMap.set(imdbId, null) // Cache "not found" result
    }
  } catch (error) {
    console.error('Error fetching TMDB series ID for imdbId:', imdbId, error.message)
    // Don't cache API errors - allow retry on next call
    // Return null but don't cache the error
    return null
  }
  
  return imdbIdTmdbMap.get(imdbId)
}

let tmdbEpisodeIdMap = new Map()
let tmdbEpisodeDetailsMap = new Map()
let tmdbSeriesDetailsMap = new Map()

async function getTMDBEpisodeId(tmdbId, seasonNum, episodeNum) {
  if (!tmdbId || !seasonNum || !episodeNum || !tmdbBearer) {
    console.log('Missing required parameters for TMDB episode lookup')
    return null
  }

  const cacheKey = `${tmdbId}${seasonNum}${episodeNum}`
  
  // Check cache first
  const cached = tmdbEpisodeIdMap.get(cacheKey)
  if (cached !== undefined) {
    return cached
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
      tmdbEpisodeIdMap.set(cacheKey, null) // Cache "not found" result
    }
  } catch (error) {
    console.error('Error fetching TMDB episode ID:', error.message)
    // Don't cache API errors - allow retry on next call
    // Return null but don't cache the error
    return null
  }
  
  return tmdbEpisodeIdMap.get(cacheKey)
}

async function getTMDBEpisodeDetails(tmdbId, seasonNum, episodeNum) {
  if (!tmdbId || !seasonNum || !episodeNum || !tmdbBearer) {
    return null
  }

  const cacheKey = `details_${tmdbId}${seasonNum}${episodeNum}`
  
  // Check cache first
  const cached = tmdbEpisodeDetailsMap.get(cacheKey)
  if (cached !== undefined) {
    return cached
  }

  try {
    const options = {
      method: 'GET',
      url: `https://api.themoviedb.org/3/tv/${tmdbId}/season/${seasonNum}/episode/${episodeNum}`,
      headers: {
        accept: 'application/json',
        Authorization: `Bearer ${tmdbBearer}`
      },
      params: {
        language: 'de-DE' // Request German content
      },
      timeout: 10000
    }
    
    const res = await axios.request(options)
    
    if (res.data && res.data.id) {
      tmdbEpisodeDetailsMap.set(cacheKey, res.data)
    } else {
      tmdbEpisodeDetailsMap.set(cacheKey, null)
    }
  } catch (error) {
    console.error('Error fetching TMDB episode details:', error.message)
    return null
  }
  
  return tmdbEpisodeDetailsMap.get(cacheKey)
}

async function getTMDBSeriesDetails(tmdbId) {
  if (!tmdbId || !tmdbBearer) {
    return null
  }

  // Check cache first
  const cached = tmdbSeriesDetailsMap.get(tmdbId)
  if (cached !== undefined) {
    return cached
  }

  try {
    const options = {
      method: 'GET',
      url: `https://api.themoviedb.org/3/tv/${tmdbId}`,
      headers: {
        accept: 'application/json',
        Authorization: `Bearer ${tmdbBearer}`
      },
      params: {
        language: 'de-DE', // Request German content
        append_to_response: 'content_ratings,keywords' // Include content ratings and keywords
      },
      timeout: 10000
    }
    
    const res = await axios.request(options)
    
    if (res.data && res.data.id) {
      tmdbSeriesDetailsMap.set(tmdbId, res.data)
    } else {
      tmdbSeriesDetailsMap.set(tmdbId, null)
    }
  } catch (error) {
    console.error('Error fetching TMDB series details:', error.message)
    return null
  }
  
  return tmdbSeriesDetailsMap.get(tmdbId)
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
