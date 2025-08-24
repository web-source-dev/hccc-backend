const express = require('express');
const router = express.Router();
const multer = require('multer');
const { adminAuth } = require('../middleware/auth');
const ImageUploadService = require('../services/imageUploadService');

// Configure multer for memory storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
  },
  fileFilter: (req, file, cb) => {
    // Check file type
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'), false);
    }
  },
});

// Upload image (admin only)
router.post('/image', adminAuth, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image file provided' });
    }

    const folder = req.body.folder || 'hccc_uploads';
    const result = await ImageUploadService.uploadImage(req.file, folder);

    if (result.success) {
      res.json({
        success: true,
        url: result.url,
        public_id: result.public_id
      });
    } else {
      res.status(500).json({ error: result.error });
    }
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// Delete image (admin only)
router.delete('/image/:publicId', adminAuth, async (req, res) => {
  try {
    const result = await ImageUploadService.deleteImage(req.params.publicId);
    
    if (result.success) {
      res.json({ success: true, message: 'Image deleted successfully' });
    } else {
      res.status(500).json({ error: result.error });
    }
  } catch (error) {
    console.error('Delete error:', error);
    res.status(500).json({ error: 'Delete failed' });
  }
});

module.exports = router;
