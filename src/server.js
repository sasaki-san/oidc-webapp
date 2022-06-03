const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const express = require('express');
const handlebars = require('express-handlebars');
const path = require('path');
const jwt = require('jsonwebtoken');
const jwksClient = require('jwks-rsa');
const request = require('request-promise');
const session = require('express-session');

// loading env vars from .env file
require('dotenv').config();

const nonceCookie = 'auth0rization-nonce';
let oidcProviderInfo;

const app = express();

app.use(bodyParser.urlencoded({ extended: true }));
app.use(cookieParser(crypto.randomBytes(16).toString('hex')));
app.use(
  session({
    secret: crypto.randomBytes(32).toString('hex'),
    resave: false,
    saveUninitialized: false
  })
);
app.engine('handlebars', handlebars());
app.set('view engine', 'handlebars');
app.set('views', path.join(__dirname, 'views'));

app.get('/', (req, res) => {
  res.render('index');
});

app.get('/profile', (req, res) => {
  const { idToken, decodedIdToken } = req.session;
  res.render('profile', {
    idToken,
    decodedIdToken
  });
});

app.get('/login', (req, res) => {
  // define constants for the authorization request
  const authorizationEndpoint = oidcProviderInfo['authorization_endpoint'];
  const responseType = 'code';
  const scope = 'openid profile email read:to-dos delete:to-dos';
  const clientId = process.env.CLIENT_ID;
  const redirectUri = 'http://localhost:3000/callback';
  const responseMode = 'query';
  const nonce = crypto.randomBytes(16).toString('hex');
  const audience = process.env.API_IDENTIFIER;

  // define a signed cookie containing the nonce value
  const options = {
    maxAge: 1000 * 60 * 15,
    httpOnly: true, // The cookie only accessible by the web browser
    signed: true // Indicates if the cookie should be signed
  };

  // add cookie to the response and issue a 302 redirecting user
  res
    .cookie(nonceCookie, nonce, options)
    .redirect(
      authorizationEndpoint +
        `?response_mode=${responseMode}` +
        `&response_type=${responseType}` +
        `&scope=${scope}` +
        `&client_id=${clientId}` +
        `&redirect_uri=${redirectUri}` +
        `&nonce=${nonce}` +
        `&audience=${audience}`
    );
});

function validateToken(idToken, nonce) {
  const decodedToken = jwt.decode(idToken);

  // fetch ID token details
  const {
    nonce: decodedNonce,
    aud: audience,
    exp: expirationDate,
    iss: issuer
  } = decodedToken;

  const currentTime = Math.floor(Date.now() / 1000);

  const expectedAudience = process.env.CLIENT_ID;

  // validate ID Tokens
  if (
    audience !== expectedAudience ||
    decodedNonce !== nonce ||
    expirationDate < currentTime ||
    issuer !== oidcProviderInfo['issuer']
  ) {
    throw Error();
  }

  // No need to check the signature, as it came through a secure channel (which uses TLS certificates)

  return decodedToken;
}

app.get('/callback', async (req, res) => {
  const { code } = req.query;

  const codeExchangeOptions = {
    grant_type: 'authorization_code',
    client_id: process.env.CLIENT_ID,
    client_secret: process.env.CLIENT_SECRET,
    code: code,
    redirect_uri: 'http://localhost:3000/callback'
  };

  const codeExchangeResponse = await request.post(
    `https://${process.env.OIDC_PROVIDER}/oauth/token`,
    { form: codeExchangeOptions }
  );

  // parse response to get tokens
  const tokens = JSON.parse(codeExchangeResponse);
  req.session.accessToken = tokens.access_token;

  // extract nonce from cookie
  const nonce = req.signedCookies[nonceCookie];
  delete req.signedCookies[nonceCookie];

  try {
    req.session.decodedIdToken = validateToken(tokens.id_token, nonce);
    req.session.idToken = tokens.id_token;
    res.redirect('/profile');
  } catch (error) {
    res.status(401).send();
  }
});

app.post('/callback', async (req, res) => {
  // take nonce from cookie
  const nonce = req.signedCookies[nonceCookie];

  // delete nonce
  delete req.signedCookies[nonceCookie];

  // take ID token posted by the user
  const { id_token } = req.body;

  // decore token
  const decodedToken = jwt.decode(id_token, { complete: true });

  // get key id
  const kid = decodedToken.header.kid;

  // get public key
  const client = jwksClient({
    jwksUri: oidcProviderInfo['jwks_uri']
  });

  client.getSigningKey(kid, (err, key) => {
    const signingKey = key.publicKey || key.rsaPublicKey;

    // verify signature & decode token
    const verifiedToken = jwt.verify(id_token, signingKey);

    // check audience, nonce, and expiration time
    const {
      nonce: decodedNonce,
      aud: audience,
      exp: expirationDate,
      iss: issuer
    } = verifiedToken;

    const currentTime = Math.floor(Date.now() / 1000);

    const expectedAudience = process.env.CLIENT_ID;

    if (
      audience !== expectedAudience ||
      decodedNonce !== nonce ||
      expirationDate < currentTime ||
      issuer !== oidcProviderInfo['issuer']
    ) {
      // send an unauthorized http status
      return res.status(401).send();
    }

    req.session.decodedIdToken = verifiedToken;
    req.session.idToken = id_token;

    // send the decoded version of th ID token
    res.redirect('/profile');
  });
});

app.get('/to-dos', async (req, res) => {
  const delegatedRequestOptions = {
    url: 'http://localhost:3001',
    headers: {
      Authorization: `Bearer ${req.session.accessToken}`
    }
  };

  try {
    const delegatedResponse = await request(delegatedRequestOptions);
    const toDos = JSON.parse(delegatedResponse);

    res.render('to-dos', {
      toDos
    });
  } catch (error) {
    res.status(error.statusCode).send(error);
  }
});

app.get('/remove-to-do/:id', async (req, res) => {
  const delegatedRequestOptions = {
    url: `http://localhost:3001/${req.params.id}`,
    headers: {
      Authorization: `Bearer ${req.session.accessToken}`
    }
  };

  try {
    const delegatedResponse = await request.delete(delegatedRequestOptions);
    const result = JSON.parse(delegatedResponse);

    const delegatedRequestOptions2 = {
      url: 'http://localhost:3001',
      headers: {
        Authorization: `Bearer ${req.session.accessToken}`
      }
    };

    const delegatedResponse2 = await request(delegatedRequestOptions2);
    const toDos = JSON.parse(delegatedResponse2);

    res.render('to-dos', {
      toDos
    });
  } catch (error) {
    res.status(error.statusCode).send(error);
  }
});

const { OIDC_PROVIDER } = process.env;
const discEnd = `https://${OIDC_PROVIDER}/.well-known/openid-configuration`;
request(discEnd)
  .then(res => {
    oidcProviderInfo = JSON.parse(res);
    console.log(oidcProviderInfo);
    app.listen(3000, () => {
      console.log(`Server running on http://localhost:3000`);
    });
  })
  .catch(err => {
    console.error(err);
    console.error(`Unable to get OIDC endpoints for ${OIDC_PROVIDER}`);
    process.exit(1);
  });
