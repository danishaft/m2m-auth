const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const dotenv = require('dotenv');
const stytch = require('stytch');
const authenticateToken = require('./middleware/middleware')

dotenv.config();

const app = express();
const PORT = process.env.PORT;

// Middleware
app.use(cors());
app.use(helmet());
app.use(morgan('combined'));
app.use(express.json());

//user profiles data
const userProfiles = [
    { id: 1, username: 'john_doe', email: 'john.doe@example.com', role: 'user' },
    { id: 2, username: 'jane_doe', email: 'jane.doe@example.com', role: 'admin' },
  ];

//routes
app.get('/api/profiles-data', authenticateToken('read:users'), (req, res) => {
    res.json(userProfiles);
  });


// Error handling middleware
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).send('Something went wrong!');
});
  
  // Start the server
  app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});