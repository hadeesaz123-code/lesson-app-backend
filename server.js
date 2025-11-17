// Express backend with MongoDB storage for lessons and orders.
// Implements: logger middleware, image serving with clear 404s, /lessons GET,
// /search GET for full-text search, /orders POST, and /lessons/:id PUT for updates.

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { MongoClient, ObjectId } = require('mongodb');

const app = express();
const PORT = process.env.PORT || 3000;
const MONGO_URL = process.env.MONGO_URL || 'mongodb+srv://hadeesa:14105@cluster0.9s8hiwg.mongodb.net/LessonApp?retryWrites=true&w=majority&appName=Cluster0';
const DB_NAME = process.env.DB_NAME || 'LessonApp';

app.use(cors());
app.use(express.json());

// Logs every request with method and time
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
  next();
});

// Serve images from frontend public/images folder
const IMAGES_DIR = path.join(__dirname, '../lesson-app-frontend/public/images');
app.use('/images', express.static(IMAGES_DIR));

app.get('/images/:filename', (req, res) => {
  const filename = decodeURIComponent(req.params.filename);
  const fullPath = path.join(IMAGES_DIR, filename);
  fs.access(fullPath, fs.constants.R_OK, (err) => {
    if (err) {
      return res.status(404).json({ error: 'Image not found', file: filename });
    }
    return res.sendFile(fullPath);
  });
});

// MongoDB client setup
let dbClient;
let db;
let useInMemory = false;
let memLessons = [];
let memOrders = [];

// Connect to MongoDB
async function connectDB() {
  dbClient = new MongoClient(MONGO_URL);
  try {
    console.log('Connecting to MongoDB...');
    await dbClient.connect();
    db = dbClient.db(DB_NAME);
    const collections = await db.listCollections().toArray();
    console.log('Connected to MongoDB');
    console.log(`Database: ${DB_NAME}`);
    console.log(`Collections: ${collections.map(c => c.name).join(', ') || 'none'}`);
  } catch (err) {
    useInMemory = true;
    memLessons = SAMPLE_LESSONS.map((l, i) => ({ ...l, _id: `mem-${Date.now()}-${i}` }));
    memOrders = [];
    console.error('Failed to connect to MongoDB. Using in-memory mode.');
  }
}

// Example lessons for initial setup
const SAMPLE_LESSONS = [
  { subject: 'Cooking Class', price: 25, location: 'Kitchen Lab', spaces: 10, description: 'Learn to cook delicious meals.', image: '/images/cooking-class.jpeg' },
  { subject: 'Debate Competition', price: 15, location: 'Auditorium', spaces: 20, description: 'Sharpen your public speaking skills.', image: '/images/debate-comp.jpeg' }
];

// Add lessons to MongoDB if empty
async function ensureLessons() {
  if (useInMemory) {
    if (memLessons.length === 0) {
      memLessons = SAMPLE_LESSONS.map((l, i) => ({ ...l, _id: `mem-${Date.now()}-${i}` }));
      console.log('Seeded sample lessons (in-memory)');
    }
    return;
  }
  const col = db.collection('lessons');
  const count = await col.countDocuments();
  if (count === 0) {
    await col.insertMany(SAMPLE_LESSONS);
    console.log('Inserted sample lessons into MongoDB');
  }
}

// GET /lessons - get all lessons
app.get('/lessons', async (req, res) => {
  try {
    if (useInMemory) return res.json(memLessons);
    const lessons = await db.collection('lessons').find().toArray();
    res.json(lessons);
  } catch (err) {
    res.status(500).json({ error: 'Could not fetch lessons' });
  }
});

// GET /search?q=term - search lessons
app.get('/search', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.json([]);
    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const num = Number(q);
    const or = [
      { subject: { $regex: re } },
      { description: { $regex: re } },
      { location: { $regex: re } }
    ];
    if (!Number.isNaN(num)) {
      or.push({ price: num });
      or.push({ spaces: num });
    }

    if (useInMemory) {
      const filtered = memLessons.filter(l => re.test(l.subject) || re.test(l.description) || re.test(l.location));
      return res.json(filtered);
    }

    const results = await db.collection('lessons').find({ $or: or }).toArray();
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: 'Search failed' });
  }
});

// POST /orders - save new order
app.post('/orders', async (req, res) => {
  try {
    const { name, phone, email, items } = req.body;

    // Check that required fields are present
    if (!name || !phone || !email || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Missing order fields' });
    }

    const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    if (!emailOk) {
      return res.status(400).json({ error: 'Invalid email address' });
    }

    const order = { name, phone, email, items, createdAt: new Date() };

    if (useInMemory) {
      const id = `order-${Date.now()}`;
      memOrders.unshift({ ...order, _id: id });
      return res.status(201).json({ insertedId: id, warning: 'Saved in memory only (MongoDB not connected)' });
    }

    // Save to MongoDB (collection name: order)
    const result = await db.collection('order').insertOne(order);
    res.status(201).json({ insertedId: result.insertedId, message: 'Order saved successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Could not save order', details: err.message });
  }
});

// PUT /lessons/:id - update a lesson (e.g. spaces after order)
app.put('/lessons/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const updates = req.body;
    delete updates._id;

    if (useInMemory) {
      const lesson = memLessons.find(l => l._id === id);
      if (!lesson) return res.status(404).json({ error: 'Lesson not found' });
      Object.assign(lesson, updates);
      return res.json(lesson);
    }

    const filter = { _id: ObjectId.isValid(id) ? new ObjectId(id) : id };
    const result = await db.collection('lessons').findOneAndUpdate(filter, { $set: updates }, { returnDocument: 'after' });
    if (!result.value) return res.status(404).json({ error: 'Lesson not found' });
    res.json(result.value);
  } catch (err) {
    res.status(500).json({ error: 'Could not update lesson' });
  }
});

// GET /status - check MongoDB connection status
app.get('/status', async (req, res) => {
  try {
    const status = {
      mongodb: {
        connected: !useInMemory && db !== undefined,
        database: DB_NAME,
        mode: useInMemory ? 'in-memory' : 'mongodb'
      }
    };

    if (!useInMemory && db) {
      const ordersCount = await db.collection('order').countDocuments();
      const lessonsCount = await db.collection('lessons').countDocuments();
      status.mongodb.ordersCount = ordersCount;
      status.mongodb.lessonsCount = lessonsCount;
    } else if (useInMemory) {
      status.mongodb.ordersCount = memOrders.length;
      status.mongodb.lessonsCount = memLessons.length;
    }

    res.json(status);
  } catch (err) {
    res.status(500).json({ error: 'Could not check status' });
  }
});

// GET /orders - show recent orders (for development/testing)
app.get('/orders', async (req, res) => {
  try {
    if (useInMemory) {
      return res.json({ mode: 'in-memory', orders: memOrders });
    }
    const orders = await db.collection('order').find().sort({ createdAt: -1 }).limit(50).toArray();
    res.json({ mode: 'mongodb', count: orders.length, orders });
  } catch (err) {
    res.status(500).json({ error: 'Could not fetch orders', details: err.message });
  }
});

// Start server
connectDB()
  .then(() => ensureLessons())
  .then(() => {
    app.listen(PORT, () => {
      console.log('Server running on http://localhost:' + PORT);
      if (useInMemory) {
        console.warn('Running in in-memory mode (MongoDB not connected)');
      } else {
        console.log('MongoDB connected. Orders will be saved in collection: order');
      }
    });
  })
  .catch((err) => {
    console.error('Failed to start server:', err);
  });
