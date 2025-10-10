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
const debugMode = process.env.TMDB_DEBUG === 'true'

// Statistics tracking
const enrichmentStats = {
  totalPrograms: 0,
  imdbBasedAttempts: 0,
  imdbBasedSuccess: 0,
  titleBasedAttempts: 0,
  titleBasedSuccess: 0,
  movieSearches: 0,
  tvSearches: 0,
  movieMatches: 0,
  tvMatches: 0,
  skippedLowConfidence: 0,
  skippedNonContent: 0,
  skippedNonEntertainment: 0,
  apiCalls: 0,
  cacheHits: 0,
  errors: 0,
  startTime: null
}


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
  async parser({ content, channel, date }) {
    const programs = []
    try {
      const items = parseItems(content)
      
      // Initialize stats on first run
      if (enrichmentStats.startTime === null) {
        enrichmentStats.startTime = Date.now()
        console.log('🎬 Starting TMDB enrichment with smart lookup...')
      }
      
      // Check for throttling (empty program list)
      if (items.length === 0) {
        console.warn(`Empty program list for channel ${channel?.site_id} on ${date} - possible throttling`)
        
        // If this is a throttled response, we could retry here
        // But since we're in the parser, we'll just return empty and let the global delay system handle it
        return programs
      } else {
        console.log(`Successfully parsed ${items.length} programs for channel ${channel?.site_id}`)
      }
      
      enrichmentStats.totalPrograms += items.length
      
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
            titles: [{ lang: 'de', value: item.name || 'Unknown Title' }], // Add language info for grouping
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
              titles: [{ lang: 'de', value: item.name || 'Unknown Title' }], // Add language info for grouping
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
  if (!tmdbBearer) {
    return {}
  }
  
  try {
    // First try the existing IMDB-based approach
    if (item.externalIds) {
      const externalIds = JSON.parse(item.externalIds)
      const imdbId = externalIds.find(externalId => externalId.type === 'imdb' && externalId.id)?.id
      
      if (imdbId && item.seasonNum && item.subNum) {
        enrichmentStats.imdbBasedAttempts++
        const tmdbSeriesId = await getTMDBSeriesId(imdbId)
        if (tmdbSeriesId) {
          enrichmentStats.imdbBasedSuccess++
          return await enrichWithTMDBData(tmdbSeriesId, item, true)
        }
      }
    }
    
    // If no IMDB ID or IMDB lookup failed, try smart title-based search
    const confidence = calculateSearchConfidence(item)
    if (debugMode) {
      console.log(`🎯 Confidence for "${item.name}": ${confidence.score} (${confidence.isMovie ? 'movie' : confidence.isTVShow ? 'TV' : 'unknown'})`)
    }
    if (confidence.score < 0.6) {
      if (confidence.score === 0) {
        if (confidence.reason === 'non-entertainment') {
          enrichmentStats.skippedNonEntertainment++
          if (debugMode) {
            console.log(`⏭️ Skipping "${item.name}" - non-entertainment`)
          }
        } else {
          enrichmentStats.skippedNonContent++
          if (debugMode) {
            console.log(`⏭️ Skipping "${item.name}" - non-content`)
          }
        }
      } else {
        enrichmentStats.skippedLowConfidence++
        if (debugMode) {
          console.log(`⏭️ Skipping "${item.name}" - low confidence (${confidence.score})`)
        }
      }
      return {}
    }
    
    enrichmentStats.titleBasedAttempts++
    
    if (debugMode) {
      console.log(`🚀 Attempting title-based search for "${item.name}" (confidence: ${confidence.score})`)
    }
    
    // Try different search strategies based on content type
    if (confidence.isMovie) {
      enrichmentStats.movieSearches++
      const result = await searchAndEnrichMovie(item)
      if (Object.keys(result).length > 0) {
        enrichmentStats.movieMatches++
        enrichmentStats.titleBasedSuccess++
      }
      return result
    } else if (confidence.isTVShow) {
      enrichmentStats.tvSearches++
      const result = await searchAndEnrichTVShow(item)
      if (Object.keys(result).length > 0) {
        enrichmentStats.tvMatches++
        enrichmentStats.titleBasedSuccess++
      }
      return result
    }
    
    return {}
    
  } catch (error) {
    enrichmentStats.errors++
    return {}
  }
}

function calculateSearchConfidence(item) {
  const title = item.name?.trim()
  const year = item.producedate ? new Date(item.producedate).getFullYear() : null
  const hasSeasonEpisode = item.seasonNum && item.subNum
  const hasCast = item.cast && (item.cast.director || item.cast.actor)
  const hasCountry = item.country
  const hasGenres = item.genres
  
  // Skip obvious non-content
  const skipPatterns = [
    /^(Tagesschau|Nachrichten|Wetter|Sport|News)/i,
    /^(Werbung|Commercial)/i,
    /^(Live|Direkt)/i,
    /^(Teleshopping|Infomercial)/i
  ]
  
  if (skipPatterns.some(pattern => pattern.test(title))) {
    return { score: 0, isMovie: false, isTVShow: false }
  }
  
  // Skip specific German categories that are typically non-entertainment
  const nonEntertainmentCategories = [
    'Dokumentation', 'Geschichte', 'Kultur', 'Magazin', 
    'Nachrichten', 'News', 'Politik', 'Reportage', 'Wissen'
  ]
  
  if (hasGenres) {
    const genres = item.genres
      .replace('und', ',')
      .split(',')
      .map(g => g.trim())
    
    // If any genre matches non-entertainment categories, skip
    if (genres.some(genre => nonEntertainmentCategories.includes(genre))) {
      return { score: 0, isMovie: false, isTVShow: false, reason: 'non-entertainment' }
    }
  }
  
  let score = 0
  let isMovie = false
  let isTVShow = false
  
  // Base score for having a title
  if (title && title.length > 3) score += 0.3
  
  // Year helps significantly
  if (year && year > 1900 && year < 2030) score += 0.3
  
  // Movies: title + year + country is high confidence
  if (title && year && hasCountry && !hasSeasonEpisode) {
    score += 0.4
    isMovie = true
  }
  
  // TV Shows: title + season/episode + year is medium-high confidence
  if (title && hasSeasonEpisode && year) {
    score += 0.3
    isTVShow = true
  }
  
  // Additional confidence boosters
  if (hasCast) score += 0.1
  if (hasGenres) score += 0.1
  
  // Penalize very generic titles
  const genericTitles = ['Film', 'Serie', 'Sendung', 'Programm', 'Show']
  if (genericTitles.includes(title)) score -= 0.2
  
  return { 
    score: Math.min(score, 1.0), 
    isMovie, 
    isTVShow,
    year,
    title
  }
}

async function searchAndEnrichMovie(item) {
  const year = item.producedate ? new Date(item.producedate).getFullYear() : null
  
  try {
    // Just search with the original title - let TMDB handle it
    const searchResults = await searchTMDBMovies(item.name, year)
    
    if (!searchResults || searchResults.length === 0) {
      console.log(`No TMDB movie results for "${item.name}"`)
      return {}
    }
    
    const bestMatch = searchResults[0] // First result is most relevant
    console.log(`Found TMDB movie match: "${bestMatch.title}" (${bestMatch.release_date}) for "${item.name}"`)
    
    // Fetch detailed movie information
    const movieDetails = await getTMDBMovieDetails(bestMatch.id)
    if (!movieDetails) return {}
    
    return await enrichMovieData(movieDetails)
    
  } catch (error) {
    console.warn('Error searching for movie:', error.message)
    return {}
  }
}

async function searchAndEnrichTVShow(item) {
  const year = item.producedate ? new Date(item.producedate).getFullYear() : null
  const seasonNum = item.seasonNum
  const episodeNum = item.subNum
  
  try {
    // Just search with the original title - let TMDB handle it
    const searchResults = await searchTMDBTVShows(item.name, year)
    
    if (!searchResults || searchResults.length === 0) {
      console.log(`No TMDB TV results for "${item.name}"`)
      return {}
    }
    
    const bestMatch = searchResults[0] // First result is most relevant
    console.log(`Found TMDB TV match: "${bestMatch.name}" (${bestMatch.first_air_date}) for "${item.name}"`)
    
    // Fetch detailed TV show and episode information
    const [seriesDetails, episodeDetails] = await Promise.all([
      getTMDBSeriesDetails(bestMatch.id),
      getTMDBEpisodeDetails(bestMatch.id, seasonNum, episodeNum)
    ])
    
    if (!seriesDetails) return {}
    
    return await enrichWithTMDBData(bestMatch.id, item, false, seriesDetails, episodeDetails)
    
  } catch (error) {
    console.warn('Error searching for TV show:', error.message)
    return {}
  }
}


function calculateStringSimilarity(str1, str2) {
  // Simple similarity calculation - can be improved with more sophisticated algorithms
  const longer = str1.length > str2.length ? str1 : str2
  const shorter = str1.length > str2.length ? str2 : str1
  
  if (longer.length === 0) return 1.0
  
  const editDistance = levenshteinDistance(longer, shorter)
  return (longer.length - editDistance) / longer.length
}

function levenshteinDistance(str1, str2) {
  const matrix = []
  
  for (let i = 0; i <= str2.length; i++) {
    matrix[i] = [i]
  }
  
  for (let j = 0; j <= str1.length; j++) {
    matrix[0][j] = j
  }
  
  for (let i = 1; i <= str2.length; i++) {
    for (let j = 1; j <= str1.length; j++) {
      if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1]
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        )
      }
    }
  }
  
  return matrix[str2.length][str1.length]
}

async function enrichWithTMDBData(tmdbId, item, isFromIMDB = false, seriesDetails = null, episodeDetails = null) {
  try {
    // Fetch data if not provided
    if (!seriesDetails || !episodeDetails) {
      [episodeDetails, seriesDetails] = await Promise.all([
        getTMDBEpisodeDetails(tmdbId, item.seasonNum, item.subNum),
        getTMDBSeriesDetails(tmdbId)
      ])
    }
    
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
    
    // Enhanced images from TMDB
    const images = []
    
    // Episode still
    if (episodeDetails?.still_path) {
      images.push({
        type: 'still',
        value: `https://image.tmdb.org/t/p/original${episodeDetails.still_path}`
      })
    }
    
    // Series poster
    if (seriesDetails?.poster_path) {
      images.push({
        type: 'poster',
        value: `https://image.tmdb.org/t/p/original${seriesDetails.poster_path}`
      })
    }
    
    // Series backdrop
    if (seriesDetails?.backdrop_path) {
      images.push({
        type: 'backdrop',
        value: `https://image.tmdb.org/t/p/original${seriesDetails.backdrop_path}`
      })
    }
    
    // Additional images from series images endpoint
    if (seriesDetails?.images?.backdrops) {
      seriesDetails.images.backdrops.slice(0, 3).forEach(backdrop => {
        images.push({
          type: 'backdrop',
          value: `https://image.tmdb.org/t/p/original${backdrop.file_path}`
        })
      })
    }
    
    if (seriesDetails?.images?.posters) {
      seriesDetails.images.posters.slice(0, 2).forEach(poster => {
        images.push({
          type: 'poster',
          value: `https://image.tmdb.org/t/p/original${poster.file_path}`
        })
      })
    }
    
    enhancedData.images = images
    
    // Set primary icon (first poster or still for thumbnail)
    if (images.length > 0) {
      enhancedData.icon = images.find(img => img.type === 'poster')?.value || 
                         images.find(img => img.type === 'still')?.value ||
                         images[0].value
    }
    
    // Enhanced keywords/tags from series
    if (seriesDetails?.keywords?.results) {
      enhancedData.keywords = seriesDetails.keywords.results.map(k => k.name)
    }
    
    // Enhanced external IDs
    if (seriesDetails?.external_ids) {
      enhancedData.externalIds = {
        imdb: seriesDetails.external_ids.imdb_id,
        tmdb: seriesDetails.id,
        facebook: seriesDetails.external_ids.facebook_id,
        instagram: seriesDetails.external_ids.instagram_id,
        twitter: seriesDetails.external_ids.twitter_id
      }
    }
    
    // Enhanced videos/trailers from series
    if (seriesDetails?.videos?.results) {
      const trailers = seriesDetails.videos.results.filter(video => 
        video.type === 'Trailer' && video.site === 'YouTube'
      )
      if (trailers.length > 0) {
        enhancedData.trailer = `https://www.youtube.com/watch?v=${trailers[0].key}`
      }
    }
    
    // Enhanced content ratings from TMDB (age restrictions/certifications)
    if (seriesDetails?.content_ratings?.results) {
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
    console.warn('Error enriching TMDB data:', error.message)
    return {}
  }
}

async function enrichMovieData(movieDetails) {
  const enhancedData = {}
  
  // Enhanced description
  if (movieDetails.overview) {
    enhancedData.description = movieDetails.overview
  }
  
  // Enhanced categories from TMDB genres
  if (movieDetails.genres) {
    enhancedData.categories = movieDetails.genres.map(g => g.name)
  }
  
  // Enhanced cast from TMDB cast
  if (movieDetails.cast) {
    enhancedData.actors = movieDetails.cast.slice(0, 10).map(actor => actor.name)
  }
  
  // Enhanced directors from TMDB crew
  if (movieDetails.crew) {
    enhancedData.directors = movieDetails.crew
      .filter(person => person.job === 'Director')
      .map(person => person.name)
  }
  
  // Enhanced writers from TMDB crew
  if (movieDetails.crew) {
    enhancedData.writers = movieDetails.crew
      .filter(person => ['Writer', 'Screenplay', 'Story'].includes(person.job))
      .map(person => person.name)
  }
  
  // Enhanced images from TMDB
  const images = []
  
  // Poster
  if (movieDetails.poster_path) {
    images.push({
      type: 'poster',
      value: `https://image.tmdb.org/t/p/original${movieDetails.poster_path}`
    })
    enhancedData.icon = images[0].value
  }
  
  // Backdrop
  if (movieDetails.backdrop_path) {
    images.push({
      type: 'backdrop',
      value: `https://image.tmdb.org/t/p/original${movieDetails.backdrop_path}`
    })
  }
  
  // Additional images from images endpoint
  if (movieDetails.images?.backdrops) {
    movieDetails.images.backdrops.slice(0, 3).forEach(backdrop => {
      images.push({
        type: 'backdrop',
        value: `https://image.tmdb.org/t/p/original${backdrop.file_path}`
      })
    })
  }
  
  if (movieDetails.images?.posters) {
    movieDetails.images.posters.slice(0, 2).forEach(poster => {
      images.push({
        type: 'poster',
        value: `https://image.tmdb.org/t/p/original${poster.file_path}`
      })
    })
  }
  
  enhancedData.images = images
  
  // Enhanced keywords/tags
  if (movieDetails.keywords?.keywords) {
    enhancedData.keywords = movieDetails.keywords.keywords.map(k => k.name)
  }
  
  // Enhanced external IDs
  if (movieDetails.external_ids) {
    enhancedData.externalIds = {
      imdb: movieDetails.external_ids.imdb_id,
      tmdb: movieDetails.id,
      facebook: movieDetails.external_ids.facebook_id,
      instagram: movieDetails.external_ids.instagram_id,
      twitter: movieDetails.external_ids.twitter_id
    }
  }
  
  // Enhanced videos/trailers
  if (movieDetails.videos?.results) {
    const trailers = movieDetails.videos.results.filter(video => 
      video.type === 'Trailer' && video.site === 'YouTube'
    )
    if (trailers.length > 0) {
      enhancedData.trailer = `https://www.youtube.com/watch?v=${trailers[0].key}`
    }
  }
  
  // Enhanced content ratings
  if (movieDetails.release_dates?.results) {
    const germanRating = movieDetails.release_dates.results.find(rating => rating.iso_3166_1 === 'DE')
    const usRating = movieDetails.release_dates.results.find(rating => rating.iso_3166_1 === 'US')
    const anyRating = movieDetails.release_dates.results[0]
    
    const selectedRating = germanRating || usRating || anyRating
    
    if (selectedRating && selectedRating.release_dates?.[0]?.certification) {
      enhancedData.rating = {
        system: selectedRating.iso_3166_1 === 'DE' ? 'FSK' : 
               selectedRating.iso_3166_1 === 'US' ? 'MPAA' : 
               'themoviedb.org',
        value: selectedRating.release_dates[0].certification
      }
    }
  }
  
  // Enhanced star ratings
  if (movieDetails.vote_average && movieDetails.vote_count > 10) {
    const stars = Math.round(movieDetails.vote_average / 2)
    enhancedData.starRatings = [
      {
        system: 'themoviedb.org',
        value: `${stars}/5`
      }
    ]
  }
  
  // Enhanced keywords
  if (movieDetails.keywords?.results) {
    enhancedData.keywords = movieDetails.keywords.results.map(keyword => keyword.name)
  }
  
  return enhancedData
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
let tmdbMovieSearchMap = new Map()
let tmdbTVSearchMap = new Map()
let tmdbMovieDetailsMap = new Map()

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
        append_to_response: 'content_ratings,keywords,credits,videos,images,external_ids,reviews'
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

// TMDB Search Functions
async function searchTMDBMovies(title, year) {
  if (!title || !tmdbBearer) return []
  
  const cacheKey = `movie_${title}_${year || 'no_year'}`
  
  // Check cache first
  const cached = tmdbMovieSearchMap.get(cacheKey)
  if (cached !== undefined) {
    enrichmentStats.cacheHits++
    return cached
  }
  
  try {
    enrichmentStats.apiCalls++
    const options = {
      method: 'GET',
      url: 'https://api.themoviedb.org/3/search/movie',
      headers: {
        accept: 'application/json',
        Authorization: `Bearer ${tmdbBearer}`
      },
      params: {
        query: title,
        year: year || undefined,
        language: 'de-DE',
        page: 1
      },
      timeout: 10000
    }
    
    const res = await axios.request(options)
    
    if (res.data && res.data.results) {
      tmdbMovieSearchMap.set(cacheKey, res.data.results)
      return res.data.results
    } else {
      tmdbMovieSearchMap.set(cacheKey, [])
      return []
    }
  } catch (error) {
    console.error('Error searching TMDB movies:', error.message)
    return []
  }
}

async function searchTMDBTVShows(title, year) {
  if (!title || !tmdbBearer) return []
  
  const cacheKey = `tv_${title}_${year || 'no_year'}`
  
  // Check cache first
  const cached = tmdbTVSearchMap.get(cacheKey)
  if (cached !== undefined) {
    enrichmentStats.cacheHits++
    return cached
  }
  
  try {
    enrichmentStats.apiCalls++
    const options = {
      method: 'GET',
      url: 'https://api.themoviedb.org/3/search/tv',
      headers: {
        accept: 'application/json',
        Authorization: `Bearer ${tmdbBearer}`
      },
      params: {
        query: title,
        first_air_date_year: year || undefined,
        language: 'de-DE',
        page: 1
      },
      timeout: 10000
    }
    
    const res = await axios.request(options)
    
    if (res.data && res.data.results) {
      tmdbTVSearchMap.set(cacheKey, res.data.results)
      return res.data.results
    } else {
      tmdbTVSearchMap.set(cacheKey, [])
      return []
    }
  } catch (error) {
    console.error('Error searching TMDB TV shows:', error.message)
    return []
  }
}

async function getTMDBMovieDetails(movieId) {
  if (!movieId || !tmdbBearer) return null
  
  // Check cache first
  const cached = tmdbMovieDetailsMap.get(movieId)
  if (cached !== undefined) {
    enrichmentStats.cacheHits++
    return cached
  }
  
  try {
    enrichmentStats.apiCalls++
    const options = {
      method: 'GET',
      url: `https://api.themoviedb.org/3/movie/${movieId}`,
      headers: {
        accept: 'application/json',
        Authorization: `Bearer ${tmdbBearer}`
      },
      params: {
        language: 'de-DE',
        append_to_response: 'credits,keywords,release_dates,videos,images,external_ids,reviews'
      },
      timeout: 10000
    }
    
    const res = await axios.request(options)
    
    if (res.data && res.data.id) {
      tmdbMovieDetailsMap.set(movieId, res.data)
      return res.data
    } else {
      tmdbMovieDetailsMap.set(movieId, null)
      return null
    }
  } catch (error) {
    console.error('Error fetching TMDB movie details:', error.message)
    return null
  }
}

// Summary function to print enrichment statistics
function printEnrichmentSummary() {
  if (enrichmentStats.startTime === null) return
  
  const duration = Date.now() - enrichmentStats.startTime
  const durationSeconds = (duration / 1000).toFixed(1)
  
  console.log('\n' + '='.repeat(80))
  console.log('🎬 TMDB ENRICHMENT SUMMARY')
  console.log('='.repeat(80))
  console.log(`⏱️  Duration: ${durationSeconds}s`)
  console.log(`📊 Total Programs Processed: ${enrichmentStats.totalPrograms}`)
  console.log('')
  
  if (tmdbBearer) {
    console.log('🔍 ENRICHMENT ATTEMPTS:')
    console.log(`   • IMDB-based attempts: ${enrichmentStats.imdbBasedAttempts}`)
    console.log(`   • Title-based attempts: ${enrichmentStats.titleBasedAttempts}`)
    console.log(`   • Movie searches: ${enrichmentStats.movieSearches}`)
    console.log(`   • TV show searches: ${enrichmentStats.tvSearches}`)
    console.log('')
    
    console.log('✅ SUCCESSFUL MATCHES:')
    console.log(`   • IMDB-based success: ${enrichmentStats.imdbBasedSuccess} (${enrichmentStats.imdbBasedAttempts > 0 ? ((enrichmentStats.imdbBasedSuccess / enrichmentStats.imdbBasedAttempts) * 100).toFixed(1) : 0}%)`)
    console.log(`   • Title-based success: ${enrichmentStats.titleBasedSuccess} (${enrichmentStats.titleBasedAttempts > 0 ? ((enrichmentStats.titleBasedSuccess / enrichmentStats.titleBasedAttempts) * 100).toFixed(1) : 0}%)`)
    console.log(`   • Movie matches: ${enrichmentStats.movieMatches}`)
    console.log(`   • TV show matches: ${enrichmentStats.tvMatches}`)
    console.log('')
    
    console.log('⏭️  SKIPPED:')
    console.log(`   • Low confidence: ${enrichmentStats.skippedLowConfidence}`)
    console.log(`   • Non-content (news, weather, etc.): ${enrichmentStats.skippedNonContent}`)
    console.log(`   • Non-entertainment (docs, politics, etc.): ${enrichmentStats.skippedNonEntertainment}`)
    console.log('')
    
    console.log('🌐 API USAGE:')
    console.log(`   • API calls made: ${enrichmentStats.apiCalls}`)
    console.log(`   • Cache hits: ${enrichmentStats.cacheHits}`)
    console.log(`   • Cache hit rate: ${enrichmentStats.apiCalls + enrichmentStats.cacheHits > 0 ? ((enrichmentStats.cacheHits / (enrichmentStats.apiCalls + enrichmentStats.cacheHits)) * 100).toFixed(1) : 0}%`)
    console.log('')
    
    if (enrichmentStats.errors > 0) {
      console.log(`❌ Errors: ${enrichmentStats.errors}`)
    }
    
    const totalEnriched = enrichmentStats.imdbBasedSuccess + enrichmentStats.titleBasedSuccess
    const enrichmentRate = enrichmentStats.totalPrograms > 0 ? ((totalEnriched / enrichmentStats.totalPrograms) * 100).toFixed(1) : 0
    console.log(`🎯 Overall enrichment rate: ${enrichmentRate}% (${totalEnriched}/${enrichmentStats.totalPrograms})`)
    
  } else {
    console.log('⚠️  TMDB bearer token not configured - no enrichment attempted')
    console.log('   Set TMDBBEARER environment variable to enable enrichment')
  }
  
  console.log('='.repeat(80))
}

// Export the summary function so it can be called from outside
module.exports.printEnrichmentSummary = printEnrichmentSummary
