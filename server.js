const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { Pool } = require('pg');
const cloudinary = require('cloudinary').v2;
const crypto = require('crypto');
require('dotenv').config();

const app = express();
app.use(express.json({ limit: '50mb' })); // Base64 avatar এর জন্য লিমিট বাড়ানো হলো

const cors = require('cors');
app.use(cors());

const upload = multer({ storage: multer.memoryStorage() });

// --- Hash to Index Method & Multi-DB Setup ---
const hashToIndex = (key, maxIndex) => {
    const hash = crypto.createHash('md5').update(key).digest('hex');
    const intVal = parseInt(hash.slice(0, 8), 16);
    return intVal % maxIndex;
};

// .env থেকে কমা (,) দিয়ে আলাদা করে ডাটাবেস ও ক্লাউডিনারি কনফিগারেশন নেওয়া এবং .trim() দিয়ে অতিরিক্ত স্পেস রিমুভ করা
const dbUrls = (process.env.DATABASE_URLS || '').split(',').map(s => s.trim()).filter(Boolean);
const cloudNames = (process.env.CLOUD_NAMES || '').split(',').map(s => s.trim()).filter(Boolean);
const cloudApiKeys = (process.env.CLOUD_API_KEYS || '').split(',').map(s => s.trim()).filter(Boolean);
const cloudApiSecrets = (process.env.CLOUD_API_SECRETS || '').split(',').map(s => s.trim()).filter(Boolean);

// PostgreSQL Pools তৈরি
const pools = dbUrls.map(url => new Pool({ connectionString: url }));

const getPool = (identifier) => {
    if (pools.length === 0) throw new Error('No database URLs provided in environment variables.');
    const index = hashToIndex(identifier, pools.length);
    return pools[index];
};

// Cloudinary Accounts তৈরি
const getCloudinaryInstance = (identifier) => {
    if (cloudNames.length === 0) throw new Error('No Cloudinary credentials provided in environment variables.');
    const index = hashToIndex(identifier, cloudNames.length);
    
    const instance = cloudinary;
    instance.config({
        cloud_name: cloudNames[index],
        api_key: cloudApiKeys[index],
        api_secret: cloudApiSecrets[index]
    });
    return instance;
};

// --- Helper Function: Cloudinary থেকে Public ID বের করার জন্য ---
const getPublicIdFromUrl = (url) => {
    try {
        const urlParts = url.split('/');
        const uploadIndex = urlParts.indexOf('upload');
        if (uploadIndex !== -1) {
            const publicIdWithExt = urlParts.slice(uploadIndex + 2).join('/');
            return publicIdWithExt.substring(0, publicIdWithExt.lastIndexOf('.'));
        }
    } catch (err) {
        console.error('Error extracting public ID:', err);
    }
    return null;
};

// --- API Routes ---

// a) Post Reel
app.post('/api/reels', upload.single('video'), async (req, res) => {
    try {
        const { username, avatar, email, location, feelings, caption, tags_people } = req.body;
        const videoFile = req.file;

        if (!videoFile) {
            return res.status(400).json({ error: 'Video file is required' });
        }

        // ১. ক্লাউডিনারি-তে ভিডিও আপলোড করা
        const cloud = getCloudinaryInstance(email);

        const uploadToCloudinary = () => {
            return new Promise((resolve, reject) => {
                const uploadStream = cloud.uploader.upload_stream(
                    { resource_type: 'video' },
                    (error, result) => {
                        if (error) reject(error);
                        else resolve(result);
                    }
                );
                uploadStream.end(videoFile.buffer);
            });
        };

        const cloudinaryResult = await uploadToCloudinary();
        const vidLink = cloudinaryResult.secure_url;

        // ২. ট্যাগ পার্স করা (ডাবল স্ট্রিংফাই এড়ানোর জন্য শুধু একবার parse করা হলো)
        let parsedTags = [];
        try {
            parsedTags = typeof tags_people === 'string' ? JSON.parse(tags_people) : (tags_people || []);
        } catch (e) {
            parsedTags = [];
        }

        // ৩. পোস্টগ্রেস ডাটাবেজে সেভ করা
        const pool = getPool(email);
        const id = uuidv4();

        const query = `
            INSERT INTO reels (id, username, avatar, email, location, feelings, caption, tags_people, vid)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING *;
        `;

        const values = [id, username, avatar, email, location, feelings, caption, JSON.stringify(parsedTags), vidLink];

        const newReel = await pool.query(query, values);
        res.status(201).json({ message: 'Reel posted successfully', reel: newReel.rows[0] });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message || 'Server error' });
    }
});



// b) Delete Reel (First Cloudinary -> Then PostgreSQL)
app.delete('/api/reels/:id', async (req, res) => {
    try {
        const { id } = req.params;
        let deletedReel = null;
        let activePool = null;

        // রিলটি খুঁজে বের করা
        for (let pool of pools) {
            const result = await pool.query('SELECT * FROM reels WHERE id = $1', [id]);
            if (result.rows.length > 0) {
                deletedReel = result.rows[0];
                activePool = pool;
                break;
            }
        }

        if (!deletedReel) {
            return res.status(404).json({ error: 'Reel not found' });
        }

        // ১. প্রথমে ক্লাউডিনারি থেকে ভিডিও ডিলিট করা
        if (deletedReel.vid && deletedReel.email) {
            try {
                const publicId = getPublicIdFromUrl(deletedReel.vid);
                if (publicId) {
                    const cloud = getCloudinaryInstance(deletedReel.email);
                    await cloud.uploader.destroy(publicId, { resource_type: 'video' });
                }
            } catch (cloudErr) {
                console.error('Cloudinary deletion failed:', cloudErr);
                return res.status(500).json({ error: 'Failed to delete video from Cloudinary' });
            }
        }

        // ২. ক্লাউড থেকে ডিলিট নিশ্চিত হওয়ার পর পোস্টগ্রেস ডাটাবেজ থেকে রো ডিলিট করা
        await activePool.query('DELETE FROM reels WHERE id = $1', [id]);

        res.json({ message: 'Reel deleted successfully from Cloudinary and Database' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// c) Edit Reel (First Cloudinary -> Then PostgreSQL)
app.put('/api/reels/:id', upload.single('video'), async (req, res) => {
    try {
        const { id } = req.params;
        const { username, avatar, email, location, feelings, tags_people } = req.body;
        const videoFile = req.file;

        let existingReel = null;
        let activePool = null;

        // আগের রিলটি খুঁজে বের করা
        for (let pool of pools) {
            const result = await pool.query('SELECT * FROM reels WHERE id = $1', [id]);
            if (result.rows.length > 0) {
                existingReel = result.rows[0];
                activePool = pool;
                break;
            }
        }

        if (!existingReel) {
            return res.status(404).json({ error: 'Reel not found' });
        }

        let vidLink = existingReel.vid;
        const targetEmail = email || existingReel.email;

        // যদি নতুন ভিডিও দেওয়া হয়, তবে ক্লাউডিনারি অপারেশন আগে হবে
        if (videoFile) {
            const cloud = getCloudinaryInstance(targetEmail);

            // ১. ক) ক্লাউড থেকে পুরনো ভিডিও ডিলিট এবং নতুন ভিডিও আপলোড
            if (existingReel.vid) {
                try {
                    const publicId = getPublicIdFromUrl(existingReel.vid);
                    if (publicId) {
                        await cloud.uploader.destroy(publicId, { resource_type: 'video' });
                    }
                } catch (err) {
                    console.error('Old video deletion error from Cloudinary:', err);
                }
            }

            const uploadToCloudinary = () => {
                return new Promise((resolve, reject) => {
                    const uploadStream = cloud.uploader.upload_stream(
                        { resource_type: 'video' },
                        (error, result) => {
                            if (error) reject(error);
                            else resolve(result);
                        }
                    );
                    uploadStream.end(videoFile.buffer);
                });
            };

            const cloudinaryResult = await uploadToCloudinary();
            vidLink = cloudinaryResult.secure_url;
        }

        // ২. ক্লাউড অপারেশন সফল হওয়ার পর পোস্টগ্রেস ডাটাবেজ আপডেট করা
        const parsedTags = tags_people ? (typeof tags_people === 'string' ? JSON.parse(tags_people) : tags_people) : JSON.parse(existingReel.tags_people || '[]');

        const query = `
            UPDATE reels 
            SET username = COALESCE($1, username),
                avatar = COALESCE($2, avatar),
                email = COALESCE($3, email),
                location = COALESCE($4, location),
                feelings = COALESCE($5, feelings),
                tags_people = COALESCE($6, tags_people),
                vid = COALESCE($7, vid)
            WHERE id = $8
            RETURNING *;
        `;
        const values = [username, avatar, email, location, feelings, JSON.stringify(parsedTags), vidLink, id];
        
        const result = await activePool.query(query, values);
        res.json({ message: 'Reel updated successfully in Cloudinary and Database', reel: result.rows[0] });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message || 'Server error' });
    }
});

// d) Fetch All Reel (Combines data from all PostgreSQL databases)
app.get('/api/reels', async (req, res) => {
    try {
        let allReels = [];
        for (let pool of pools) {
            const result = await pool.query('SELECT * FROM reels');
            allReels = allReels.concat(result.rows);
        }
        res.json(allReels);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// e) Search Reel by Reel Caption (feelings field)
app.get('/api/reels/search', async (req, res) => {
    try {
        const { caption } = req.query;
        let matchedReels = [];

        for (let pool of pools) {
            const query = 'SELECT * FROM reels WHERE feelings ILIKE $1';
            const result = await pool.query(query, [`%${caption || ''}%`]);
            matchedReels = matchedReels.concat(result.rows);
        }

        res.json(matchedReels);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// f) Fetch all reels of a user by email
app.get('/api/reels/user', async (req, res) => {
    try {
        const { email } = req.query;
        if (!email) return res.status(400).json({ error: 'Email is required' });

        const pool = getPool(email);
        const result = await pool.query('SELECT * FROM reels WHERE email = $1', [email]);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// g) Edit all reels of a user by email (caption, reel/vid, username, avatar)
app.put('/api/reels/user', async (req, res) => {
    try {
        const { email, username, avatar, feelings, vid } = req.body;
        if (!email) return res.status(400).json({ error: 'Email is required' });

        const pool = getPool(email);
        const query = `
            UPDATE reels 
            SET username = COALESCE($1, username),
                avatar = COALESCE($2, avatar),
                feelings = COALESCE($3, feelings),
                vid = COALESCE($4, vid)
            WHERE email = $5
            RETURNING *;
        `;
        const values = [username, avatar, feelings, vid, email];
        const updatedReels = await pool.query(query, values);

        res.json({ message: 'User reels updated successfully', updatedReels: updatedReels.rows });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});


// h) Fetch a single reel by its ID (Searches across all PostgreSQL databases)
app.get('/api/reels/:id', async (req, res) => {
    try {
        const { id } = req.params;
        let foundReel = null;

        for (let pool of pools) {
            const result = await pool.query('SELECT * FROM reels WHERE id = $1', [id]);
            if (result.rows.length > 0) {
                foundReel = result.rows[0];
                break;
            }
        }

        if (!foundReel) {
            return res.status(404).json({ error: 'Reel not found' });
        }

        res.json(foundReel);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`Server is running smoothly on port ${PORT}`);
});
