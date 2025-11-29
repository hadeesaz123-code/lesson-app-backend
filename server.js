// Express backend for After School Activities App.
// Handles lessons, orders, searching, image serving, and simple login/register.

const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const { MongoClient, ObjectId } = require("mongodb");

const app = express();
const PORT = process.env.PORT || 3000;

// MongoDB connection details (Atlas)
const MONGO_URL =
  process.env.MONGO_URL ||
  "mongodb+srv://hadeesa:14105@cluster0.9s8hiwg.mongodb.net/LessonApp?retryWrites=true&w=majority&appName=Cluster0";

const DB_NAME = process.env.DB_NAME || "LessonApp";

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT"],
    allowedHeaders: ["Content-Type"]
  })
);
app.use(express.json());

// Log every request (method + path + timestamp)
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
  next();
});

// Serve image files from the frontend public/images folder
const IMAGES_DIR = path.join(__dirname, 'images');
app.use("/images", express.static(IMAGES_DIR));

app.get("/images/:filename", (req, res) => {
  const filename = decodeURIComponent(req.params.filename);
  const fullPath = path.join(IMAGES_DIR, filename);

  fs.access(fullPath, fs.constants.R_OK, err => {
    if (err) {
      return res.status(404).json({ error: "Image not found", file: filename });
    }
    return res.sendFile(fullPath);
  });
});

// MongoDB / in-memory setup
let dbClient;
let db;
let useInMemory = false;
let memLessons = [];
let memOrders = [];
let memUsers = []; // in-memory users for login/register fallback

// Connect to MongoDB Atlas; if it fails, use in-memory mode
async function connectDB() {
  dbClient = new MongoClient(MONGO_URL);

  try {
    console.log("Connecting to MongoDB...");
    await dbClient.connect();
    db = dbClient.db(DB_NAME);

    const collections = await db.listCollections().toArray();
    console.log("MongoDB connected");
    console.log(
      "Collections:",
      collections.map(c => c.name).join(", ") || "none"
    );
  } catch (err) {
    useInMemory = true;
    memLessons = SAMPLE_LESSONS.map((l, i) => ({
      ...l,
      _id: `mem-${Date.now()}-${i}`
    }));
    memOrders = [];
    memUsers = [];
    console.error("MongoDB connection failed. Using in-memory mode.");
  }
}

// Sample lessons to seed DB or memory
const SAMPLE_LESSONS = [
  {
    subject: "Cooking Class",
    price: 25,
    location: "Kitchen Lab",
    spaces: 10,
    description: "Learn to cook delicious meals.",
    image: "/images/cooking-class.jpeg"
  },
  {
    subject: "Debate Competition",
    price: 15,
    location: "Auditorium",
    spaces: 20,
    description: "Sharpen your public speaking skills.",
    image: "/images/debate-comp.jpeg"
  }
];

// Ensure there are lessons in DB or memory
async function ensureLessons() {
  if (useInMemory) {
    if (memLessons.length === 0) {
      memLessons = SAMPLE_LESSONS.map((l, i) => ({
        ...l,
        _id: `mem-${Date.now()}-${i}`
      }));
      console.log("Seeded lessons in memory");
    }
    return;
  }

  const col = db.collection("lessons");
  const count = await col.countDocuments();

  if (count === 0) {
    await col.insertMany(SAMPLE_LESSONS);
    console.log("Inserted sample lessons into MongoDB");
  }
}

// GET /lessons – return all lessons
app.get("/lessons", async (req, res) => {
  try {
    if (useInMemory) return res.json(memLessons);

    const lessons = await db.collection("lessons").find().toArray();
    res.json(lessons);
  } catch (err) {
    res.status(500).json({ error: "Could not fetch lessons" });
  }
});

// GET /search?q=term – full text search on subject/description/location
app.get("/search", async (req, res) => {
  try {
    const q = (req.query.q || "").trim();
    if (!q) return res.json([]);

    const safeRegex = new RegExp(
      q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      "i"
    );
    const num = Number(q);

    const or = [
      { subject: { $regex: safeRegex } },
      { description: { $regex: safeRegex } },
      { location: { $regex: safeRegex } }
    ];

    if (!Number.isNaN(num)) {
      or.push({ price: num });
      or.push({ spaces: num });
    }

    if (useInMemory) {
      const filtered = memLessons.filter(
        l =>
          safeRegex.test(l.subject) ||
          safeRegex.test(l.description) ||
          safeRegex.test(l.location)
      );
      return res.json(filtered);
    }

    const results = await db.collection("lessons").find({ $or: or }).toArray();
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: "Search failed" });
  }
});

// POST /orders – save a new order
app.post("/orders", async (req, res) => {
  try {
    const { name, phone, email, items } = req.body;

    if (
      !name ||
      !phone ||
      !email ||
      !Array.isArray(items) ||
      items.length === 0
    ) {
      return res.status(400).json({ error: "Missing order fields" });
    }

    const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    if (!emailOk) {
      return res.status(400).json({ error: "Invalid email" });
    }

    const order = { name, phone, email, items, createdAt: new Date() };

    if (useInMemory) {
      const id = `order-${Date.now()}`;
      memOrders.unshift({ ...order, _id: id });
      return res
        .status(201)
        .json({ insertedId: id, warning: "Saved in memory" });
    }

    const result = await db.collection("order").insertOne(order);
    res
      .status(201)
      .json({ insertedId: result.insertedId, message: "Order saved" });
  } catch (err) {
    res.status(500).json({ error: "Could not save order" });
  }
});

// PUT /lessons/:id – update lesson fields (e.g. spaces)
app.put("/lessons/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const updates = req.body;
    delete updates._id;

    if (useInMemory) {
      const lesson = memLessons.find(l => l._id === id);
      if (!lesson) return res.status(404).json({ error: "Lesson not found" });

      Object.assign(lesson, updates);
      return res.json(lesson);
    }

    const filter = { _id: ObjectId.isValid(id) ? new ObjectId(id) : id };

    const result = await db
      .collection("lessons")
      .findOneAndUpdate(filter, { $set: updates }, { returnDocument: "after" });

    if (!result.value)
      return res.status(404).json({ error: "Lesson not found" });

    res.json(result.value);
  } catch (err) {
    res.status(500).json({ error: "Update failed" });
  }
});

// GET /status – show whether MongoDB is connected or running in memory
app.get("/status", async (req, res) => {
  try {
    const status = {
      connected: !useInMemory,
      mode: useInMemory ? "in-memory" : "mongodb"
    };
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: "Status check failed" });
  }
});

// GET /orders – recent orders (debug/testing)
app.get("/orders", async (req, res) => {
  try {
    if (useInMemory) return res.json(memOrders);

    const orders = await db
      .collection("order")
      .find()
      .sort({ createdAt: -1 })
      .limit(50)
      .toArray();
    res.json(orders);
  } catch (err) {
    res.status(500).json({ error: "Could not load orders" });
  }
});

// POST /register – create a new user document
app.post("/register", async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ error: "Missing fields" });
    }

    if (useInMemory) {
      const exists = memUsers.find(u => u.email === email);
      if (exists) {
        return res.status(400).json({ error: "Email already registered" });
      }

      const newUser = { _id: "mem-" + Date.now(), name, email, password };
      memUsers.push(newUser);
      return res.json({ message: "Account created (in memory)" });
    }

    const usersCol = db.collection("users");
    const exists = await usersCol.findOne({ email });
    if (exists) {
      return res.status(400).json({ error: "Email already registered" });
    }

    await usersCol.insertOne({ name, email, password });
    res.json({ message: "Account created" });
  } catch (err) {
    res.status(500).json({ error: "Registration failed" });
  }
});

// POST /login – simple email + password check
app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Missing fields" });
    }

    if (useInMemory) {
      const user = memUsers.find(u => u.email === email);
      if (!user) return res.status(400).json({ error: "User not found" });
      if (user.password !== password) {
        return res.status(400).json({ error: "Incorrect password" });
      }

      return res.json({
        message: "Login success (in memory)",
        user: { name: user.name, email: user.email }
      });
    }

    const usersCol = db.collection("users");
    const user = await usersCol.findOne({ email });
    if (!user) return res.status(400).json({ error: "User not found" });
    if (user.password !== password) {
      return res.status(400).json({ error: "Incorrect password" });
    }

    res.json({
      message: "Login success",
      user: { name: user.name, email: user.email }
    });
  } catch (err) {
    res.status(500).json({ error: "Login failed" });
  }
});

// Start server after DB connection and seeding lessons
connectDB()
  .then(() => ensureLessons())
  .then(() => {
    app.listen(PORT, () => {
      console.log("Server running on http://localhost:" + PORT);
      if (useInMemory) {
        console.warn("Running in in-memory mode");
      } else {
        console.log("MongoDB connected");
      }
    });
  })
  .catch(err => {
    console.error("Failed to start server:", err);
  });


