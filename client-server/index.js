const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const dotenv = require('dotenv');
const { MongoClient, ServerApiVersion } = require('mongodb');
const stytch = require('stytch');
const axios = require('axios');


dotenv.config();

const app = express();
const PORT = process.env.PORT;


//stytch
const client = new stytch.Client({
    project_id: process.env.STYTCH_PROJECT_ID,
    secret: process.env.STYTCH_SECRET,
  });


async function connectToMongoDB() {
    const mongoURI = process.env.MONGODB_URI;
    
    try {
        const client = await MongoClient.connect(mongoURI, {
            serverApi: {
                version: ServerApiVersion.v1,
                strict: true,
                deprecationErrors: true,
            },
            useNewUrlParser: true,
            // sslValidate: true, // Enable SSL validation
            // tlsCAFile: process.env.MONGODB_CA_FILE, // Path to CA certificate file
            // tlsCertificateKeyFile: process.env.MONGODB_CERT_KEY_FILE, // Path to client certificate and private key file
        });
        console.log('Connected to MongoDB');
        return client.db('m2m_credentials');
    } catch (err) {
        console.error('Error connecting to MongoDB:', err);
        throw err;
    }
}

// Middleware
app.use(cors());
app.use(helmet());
app.use(morgan('combined'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
let db;
//routes
app.get('/profiles', async (req, res) => {
   //create an m2m client
   try{
    // Connect to MongoDB and set up routes and server
    db = await connectToMongoDB();
    const m2mClient = await createM2MClient();
    // Get M2M access token (cached if possible)
    const accessToken = await getM2MAccessToken(m2mClient.client_id, m2mClient.client_secret)
    // Get profiles from the resource server using the obtained access token
    const profiles = await getProfilesFromResourceServer(accessToken);

    res.json({
        profiles: profiles
    });
   }catch (err){
        console.error('Error getting profiles:', err.response ? err.response.data : err.message);
            res.status(err.response ? err.response.status : 500).json({
                error: err.response ? err.response.data : 'Internal Server Error',
        });
   }
});
  
// Route to search for an m2m client
app.get('/search-m2m-client', async (req, res) => {
    try {
      // Call Stytch endpoint to search for the m2m client
      const params = {
        limit: 100,
        query: {
            operator: 'OR',
            operands: [
                {
                    filter_name: 'client_name',
                    filter_value: ['profiles-client'],
                }
            ],
        },
      };
  
      const response = await client.m2m.clients.search(params);
  
      res.json({
        search_Result: response,
      });
    } catch (err) {
      console.error('Error searching for m2m client:', err.response ? err.response.data : err.message);
      res.status(err.response ? err.response.status : 500).json({
        error: err.response ? err.response.data : 'Internal Server Error',
      });
    }
  });

  // Route to update an m2m client
app.put('/update-m2m-client/:clientId', async (req, res) => {
    try {
      const clientId = req.params.clientId;
      const status = req.body.status;
      console.log(clientId, status)
  
      // Call Stytch endpoint to update the m2m client
      const params = {
        client_id: clientId,
        status: status,
        // Include any parameters you want to update
        // Example: scopes: ['new:scope'],
      };
  
      const response = await client.m2m.clients.update(params);
  
      res.json({
        updated_m2mClient: response,
      });
    } catch (err) {
      console.error('Error updating m2m client:', err.response ? err.response.data : err.message);
      res.status(err.response ? err.response.status : 500).json({
        error: err.response ? err.response.data : 'Internal Server Error',
      });
    }
  });

  //create new m2m client 
  async function createM2MClient() {
    try {
        // Check if M2M credentials are available in MongoDB
        const storedCredentials = await getCredentials();
        if (!storedCredentials.client_id || !storedCredentials.client_secret) {
            // If not available, create a new m2m client and store the credentials
            console.log('m2m client credentials is not available')
            const params = {
                client_name: 'profiles-client',
                scopes: ['read:users', 'write:users'],
            };
            const response = await client.m2m.clients.create(params)
            //set time to rotate secret
            const expiresAt = Date.now() + 1800 * 1000; // Set expiration time to 30 mins (adjust as needed)
            const m2mClient = {
                client_id: response.m2m_client.client_id,
                client_secret: response.m2m_client.client_secret,
                expiresAt: expiresAt
            }
            // Store the new credentials securely in MongoDB
            await storeCredentials(m2mClient);
            return m2mClient
        }else if(Date.now() > storedCredentials.expiresAt){
            //30 mins elapsed, start secret rotation
            const m2mClient = await startSecretRotation(storedCredentials.client_id);

            //complete the rotation
            await completeSecretRotation(storedCredentials.client_id);
            return m2mClient;
        }
        
        return storedCredentials;
    } catch (err) {
      console.error('Error creating m2m client:', err.response);
      throw err;
    }
  }

  
  //get m2m access token
async function getM2MAccessToken(clientId, clientSecret){
    try {
        // Get M2M access token (cached if possible)
        const accessTokenInfo = await getAccessToken();
        if (accessTokenInfo && Date.now() < accessTokenInfo.expires_at) {
            // Use the cached token if it's valid
            return accessTokenInfo.access_token;
        } 

        // If the cached token is expired or not available, request a new one
        const params = {
            client_id: clientId,
            client_secret: clientSecret,
            scopes: ['read:users', 'write:users'], // Adjust scopes as needed
            grant_type: 'client_credentials'
        };

        const response = await client.m2m.token(params);

        //store new access token to db
        const expiresAt = Date.now() + response.expires_in * 1000; // Set expiration time to 1 hour (adjust as needed)
        await storeAccessToken(response.access_token, expiresAt);
        
        return response.access_token;
    }catch(err){
        console.error('Error getting m2m access token:', err.response);
        throw err;
    }
}

  //start secret rotation
  async function startSecretRotation(client_id){
    try{
        //start the secret rotation
        const params = {
            client_id: client_id
        }
        const response = await client.m2m.clients.secrets.rotateStart(params)
         //time to rotate secret
         const expiresAt = Date.now() + 1800 * 1000; // Set expiration time to 30 mins (adjust as needed)
         //switch the old client_secret for the next_client_secret
        const m2mClient = {
            client_id: response.m2m_client.client_id,
            client_secret: response.m2m_client.next_client_secret,
            expiresAt: expiresAt
        }
        // Store the new credentials securely in MongoDB
        await storeCredentials(m2mClient);
        return m2mClient;
    }catch(err){
        console.error('Error starting secret rotation:', err.response);
        throw err;
    }
  }

  
    //complete the rotation
    async function completeSecretRotation(client_id){
        try{
            //permanently switch the client_secret for the next_client_secret
            const params = {
                client_id: client_id,
            };
          
            await client.m2m.clients.secrets.rotate(params);
        }catch(err){
            console.error('Error completing secret rotation:', err.response);
            throw err;
        }
    };


//get resource from resource server
async function getProfilesFromResourceServer(accessToken) {
    const resourceServerUrl = 'http://localhost:4000/api/profiles-data'; // Replace with your resource server URL
    try {
        console.log('going to resource', accessToken)
        const response = await axios.get(resourceServerUrl, {
            headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            },
        });
  
      return response.data;
    } catch (error) {
      console.error('Error getting profiles from resource server:', error.response ? error.response.data : error.message);
      throw error;
    }
  }

  // Helper function to retrieve credentials from MongoDB
async function getCredentials() {
    try{
        const credentials = await db.collection('credentials').findOne({});
        return credentials || {};
    }catch(err){
        console.error('Error getting credentials from MongoDB:', err);
        throw err;
    }
}
// Helper function to store credentials in MongoDB
async function storeCredentials(credentials) {
   try{
    await db.collection('credentials').updateOne({}, { $set: credentials }, { upsert: true });
   }catch(err){
    console.error('Error storing credentials in MongoDB:', err);
    throw err;
   }
}


// Helper Function to get cached access token from MongoDB
async function getAccessToken() {
    try {
        // Retrieve the cached access token information from MongoDB
        return await db.collection('accessToken').findOne({});
    } catch (err) {
        console.error('Error getting access token:', err);
        throw err;
    }
}

// helper function to Store the access token and its expiration time in MongoDB
async function storeAccessToken(accessToken, expiresAt) {
    try {
        await db.collection('accessToken').updateOne({}, { $set: { access_token: accessToken, expires_at: expiresAt } }, { upsert: true });
    } catch (err) {
        console.error('Error storing access token:', err);
        throw err;
    }
}


// Error handling middleware
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).send('Something went wrong!');
});
  
  // Start the client server
  app.listen(PORT, () => {
    console.log(`Client Server is running on port ${PORT}`);
});