const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const dotenv = require('dotenv');
const { MongoClient, ServerApiVersion } = require('mongodb');
const stytch = require('stytch');
const axios = require('axios');
const mongodbHelpers = require('./Helpers/mongodb')

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

// payment details
const paymentDetails = {
    customerId: '123456',
    amount: 50,
    destination: 'Wallet123',
  };

//routes
// Endpoint to initiate the payment process
app.get('/initiate-payment', async (req, res) => {
   //create an m2m client
   try{
    // Connect to MongoDB and set up routes and server
    db = await connectToMongoDB();
    const m2mClient = await createM2MClient();
    // Get M2M access token (cached if possible)
    const accessToken = await getM2MAccessToken(m2mClient.client_id, m2mClient.client_secret)
    // initiate payment
    const accountResponse = await initiatePayment(accessToken);

    res.json(accountResponse);
   }catch (err){
        console.error(err.response ? err.response.data : err.message);
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
                    filter_value: ['payment-service'],
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
        const storedCredentials = await mongodbHelpers.getCredentials(db);
        if (!storedCredentials.client_id || !storedCredentials.client_secret) {
            // If not available, create a new m2m client and store the credentials
            console.log('m2m client credentials is not available')
            const params = {
                client_name: 'payment-service',
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
            await mongodbHelpers.storeCredentials(db, m2mClient);
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
        const accessTokenInfo = await mongodbHelpers.getAccessToken(db);
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
        await mongodbHelpers.storeAccessToken(db, response.access_token, expiresAt);
        
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
        await mongodbHelpers.storeCredentials(db, m2mClient);
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

//initiate payment
async function initiatePayment(accessToken) {
    const accountServerUrl = 'http://localhost:4000/api/check-balance'; // Replace with your resource server URL
    try {
        //request customer balance from account server
        const response = await axios.post(accountServerUrl, paymentDetails, {
            headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            },
        });
        const {accountName, balance} = response.data
        // Check if the balance is sufficient for the transaction
        if (balance >= paymentDetails.amount) {
            // Proceed with the transaction logic
            console.log('Transaction successful!');
            return `${accountName} your payment of ${paymentDetails.amount} to ${paymentDetails.destination} was successful!`;
        }
        console.log('Insufficient balance. Transaction failed.');
        return 'Insufficient balance. Transaction failed.';
    } catch (error) {
      console.error('Error connecting with the Account Server:', error.response ? error.response.data : error.message);
      throw error;
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