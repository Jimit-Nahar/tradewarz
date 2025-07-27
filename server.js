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
const stockBuffers = {}; // { username: { ticker: { data: [], index: 0 } } }


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

  const url = `https://www.alphavantage.co/query?function=TIME_SERIES_INTRADAY&symbol=${ticker}&interval=1min&apikey=YOUR_API_KEY`;

  try {
    const response = await fetch(url);
    const data = await response.json();

    const series = data['Time Series (1min)'];
    if (!series) {
      console.error("Missing Time Series (1min)", data);
      return reply.code(500).send({ error: 'Intraday data unavailable' });
    }

    const prices = Object.entries(series)
      .map(([time, values]) => ({
        time,
        price: parseFloat(values['1. open']),
      }))
      .sort((a, b) => new Date(a.time) - new Date(b.time)); 

    reply.send({ prices });

  } catch (err) {
    console.error("Alpha Vantage error:", err.message);
    reply.code(500).send({ error: 'Failed to fetch stock data' });
  }
});



fastify.get('/stock/next', async (request, reply) => {
  const { ticker } = request.query;
  const username = request.session.username || Object.keys(stockBuffers).find(k => k.startsWith('guest_')); 

  if (!ticker || !stockBuffers[username] || !stockBuffers[username][ticker]) {
    return reply.code(404).send({ error: 'No buffer data found for this ticker or session' });
  }

  const buffer = stockBuffers[username][ticker];
  const { data, index } = buffer;

  if (index >= data.length) {
    return reply.code(204).send(); 
  }

  
  const nextPoint = data[index];
  buffer.index += 1;

  return reply.send(nextPoint);
});
