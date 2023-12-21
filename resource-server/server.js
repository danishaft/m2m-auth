const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const dotenv = require('dotenv');
const stytch = require('stytch');
const authenticateToken = require('./middleware/authToken')

dotenv.config();

const app = express();
const PORT = process.env.PORT;

// Middleware
app.use(cors());
app.use(helmet());
app.use(morgan('combined'));
app.use(express.json());

//customer details
const customersDetail = [
    { id: '123456', accountName: 'john_doe', balance: 200 },
    { id: '165432', accountName: 'jane_doe', balance: 100 },
  ];

//routes
app.post('/api/check-balance', authenticateToken('read:users'), (req, res) => {
  const {customerId} = req.body;
  const customer = customersDetail.find((customer) => customer.id === customerId);
  if(customer){
    res.json({accountName: customer.accountName, balance: customer.balance})
  }else{
    res.status(400).json({error: 'Invalid Customer'})
  }
});


// Error handling middleware
app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).send('Something went wrong!', err);
});
  
  // Start the server
  app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});