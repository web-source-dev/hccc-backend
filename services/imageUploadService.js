const cloudinary = require('../config/cloudinary');

class ImageUploadService {
  static async uploadImage(file, folder = 'hccc_uploads') {
    try {
      // Convert file buffer to base64
      const b64 = Buffer.from(file.buffer).toString('base64');
      const dataURI = `data:${file.mimetype};base64,${b64}`;
      
      const result = await cloudinary.uploader.upload(dataURI, {
        folder: folder,
        resource_type: 'auto',
        transformation: [
          { width: 800, height: 600, crop: 'limit' },
          { quality: 'auto' }
        ]
      });
      
      return {
        success: true,
        url: result.secure_url,
        public_id: result.public_id
      };
    } catch (error) {
      console.error('Image upload error:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  static async deleteImage(publicId) {
    try {
      const result = await cloudinary.uploader.destroy(publicId);
      return {
        success: true,
        result
      };
    } catch (error) {
      console.error('Image deletion error:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }
}

module.exports = ImageUploadService;
