const fastify = require('fastify')({ logger: true });
const path = require('path');
const formBody = require('@fastify/formbody');
const fastifyCookie = require('@fastify/cookie');
const fastifySession = require('@fastify/session');
const cron = require('node-cron');
const { processMatches } = require('./elo');
const { authorize, change_password, signout } = require('./routes/auth');
const fs = require('fs');
const axios = require('axios');

fastify.register(formBody);
fastify.register(fastifyCookie);
fastify.register(fastifySession, {
  secret: 'onetwothreefourfivesixseveneightnineteneleventwelve',
  cookie: { secure: false },
  saveUninitialized: false
});

cron.schedule('*/25 * * * *', () => {
  processMatches();
});

fastify.register(require('@fastify/static'), {
  root: path.join(__dirname, 'static'),
  prefix: '/',
});

fastify.get('/', async (request, reply) => {
  return reply.redirect('/signup');
});

fastify.get('/signup', async (request, reply) => {
  return reply.sendFile('signup.html');
});

fastify.post('/signup', async (request, reply) => {
  const { username, password } = request.body;
  const result = await authorize("register", username, password);
  return reply.send(result);
});

fastify.get('/auth', async (request, reply) => {
  return reply.sendFile('login.html');
});

fastify.post('/auth', async (request, reply) => {
  const { username, password } = request.body;
  const result = await authorize("login", username, password);
  if (result.success) {
    request.session.username = username;
  }
  return reply.send(result);
  
});

fastify.get('/changepass', async (request, reply) => {
  return reply.sendFile('change-password.html');
});

fastify.post('/changepass', async (request, reply) => {
  const { username, currentPass, newPass } = request.body;
  const result = await change_password(username, currentPass, newPass);
  return reply.send(result);
});

fastify.listen({ port: 3000 }, (err, address) => {
  if (err) throw err;
  console.log(` Server running at ${address}`);
});
fastify.get('/dashboard', async (request, reply) => {
  const username = request.session.username;

  if (!username) {
    return reply.code(401).send({ error: 'Not logged in' });
  }

  const users = JSON.parse(fs.readFileSync('./users.json'));
  const user = users.find(u => u.username === username);

  if (!user) {
    return reply.code(404).send({ error: 'User not found' });
  }

  return {
    username: user.username,
    stats: [
      { label: "Rating (ELO)", value: user.rating },
      { label: "Total Gains", value: `$${user.totalGains}` },
      { label: "Average Return", value: `${user.avgReturn}%` },
      { label: "Win Rate", value: `${user.winRate}%` },
      { label: "Trades Made", value: user.tradesMade },
      { label: "Best Match", value: user.bestMatch }
    ],
    chartData: user.weeklyReturns,
    matchHistory: user.matchHistory
  };
});

const ALPHAVANTAGE_API_KEY = process.env.ALPHAVANTAGE_API_KEY || 'LCGSSV9SQVS6F5MX';

// /stock?ticker=XXX (Alpha Vantage version, intraday 1min, only past month)
fastify.get('/stock', async (request, reply) => {
  const { ticker } = request.query;
  if (!ticker) return reply.code(400).send({ error: 'Ticker required' });

  try {
    // Step 1: Get daily data to pick a random valid trading day within the past month
    const dailyUrl = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${encodeURIComponent(ticker)}&apikey=${ALPHAVANTAGE_API_KEY}`;
    let dailyData, dailyRaw;
    try {
      const dailyRes = await axios.get(dailyUrl, { responseType: 'text' });
      dailyRaw = dailyRes.data;
      console.log('AlphaVantage daily raw:', dailyRaw.slice(0, 200));
      dailyData = JSON.parse(dailyRaw);
    } catch (e) {
      console.error('Failed to parse Alpha Vantage daily response:', e);
      return reply.code(429).send({ error: 'API rate limit reached or Alpha Vantage returned invalid response for daily data.' });
    }
    if (!dailyData || typeof dailyData !== 'object' || Object.keys(dailyData).length === 0) {
      return reply.code(502).send({ error: 'Alpha Vantage daily returned empty or invalid data.' });
    }
    if (dailyData.Note) {
      return reply.code(429).send({ error: 'API rate limit reached. Please wait and try again.' });
    }
    if (dailyData['Error Message']) {
      return reply.code(400).send({ error: `Invalid ticker symbol: ${ticker}` });
    }
    const timeSeries = dailyData['Time Series (Daily)'];
    if (!timeSeries || typeof timeSeries !== 'object' || Object.keys(timeSeries).length === 0) {
      return reply.code(404).send({ error: 'No data available for this ticker' });
    }
    const allDates = Object.keys(timeSeries);
    // Filter to only dates within the last 31 days
    const now = new Date();
    const oneMonthAgo = new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000);
    const recentDates = allDates.filter(dateStr => {
      const d = new Date(dateStr);
      return d >= oneMonthAgo && d <= now;
    });
    if (recentDates.length < 1) {
      return reply.code(404).send({ error: 'No valid trading days in the past month for this ticker' });
    }
    // Pick a random valid trading day from the past month
    const randomIndex = Math.floor(Math.random() * recentDates.length);
    const selectedDay = recentDates[randomIndex];

    // Step 2: Get 1-minute intraday data for the selected day
    const intradayUrl = `https://www.alphavantage.co/query?function=TIME_SERIES_INTRADAY&symbol=${encodeURIComponent(ticker)}&interval=1min&outputsize=full&apikey=${ALPHAVANTAGE_API_KEY}`;
    let intradayData, intradayRaw;
    try {
      const intradayRes = await axios.get(intradayUrl, { responseType: 'text' });
      intradayRaw = intradayRes.data;
      console.log('AlphaVantage intraday raw:', intradayRaw.slice(0, 200));
      intradayData = JSON.parse(intradayRaw);
    } catch (e) {
      console.error('Failed to parse Alpha Vantage intraday response:', e);
      return reply.code(429).send({ error: 'API rate limit reached or Alpha Vantage returned invalid response for intraday data.' });
    }
    if (!intradayData || typeof intradayData !== 'object' || Object.keys(intradayData).length === 0) {
      return reply.code(502).send({ error: 'Alpha Vantage intraday returned empty or invalid data.' });
    }
    if (intradayData.Note) {
      return reply.code(429).send({ error: 'API rate limit reached. Please wait and try again.' });
    }
    if (intradayData['Error Message']) {
      return reply.code(400).send({ error: `Invalid ticker symbol: ${ticker}` });
    }
    const meta = intradayData['Meta Data'];
    const intradaySeries = intradayData['Time Series (1min)'];
    if (!intradaySeries || typeof intradaySeries !== 'object' || Object.keys(intradaySeries).length === 0) {
      return reply.code(404).send({ error: 'No intraday data available for this ticker' });
    }
    // Filter for the selected day
    const intradayPoints = Object.entries(intradaySeries)
      .filter(([datetime]) => datetime.startsWith(selectedDay))
      .map(([datetime, values]) => ({
        time: datetime,
        close: parseFloat(values['4. close'])
      }))
      .reverse(); // chronological order
    if (!intradayPoints.length) {
      return reply.code(404).send({ error: `No intraday data for selected day (${selectedDay})` });
    }
    return reply.send(intradayPoints);
  } catch (err) {
    console.error('Alpha Vantage error:', err.message);
    return reply.code(500).send({ error: 'Failed to fetch stock data' });
  }
});