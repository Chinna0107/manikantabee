const pool = require('./db');

// Map categories to perfectly generated local images
const CATEGORY_IMAGES = {
  'Necklaces': '/images/necklace.png',
  'Earrings': '/images/earrings.png',
  'Rings': '/images/rings.png',
  'Bracelets': '/images/bracelets.png',
  'Bangles': '/images/bangles.png',
  'Pendants': '/images/pendants.png',
  'Mangalsutras': '/images/mangalsutras.png',
  'Chains': '/images/chains.png',
  'Jewelry Sets': '/images/jewelry_sets.png'
};

async function seedJewelry() {
  try {
    console.log('Clearing existing categories and products...');
    await pool.query('TRUNCATE TABLE products RESTART IDENTITY CASCADE');
    await pool.query('TRUNCATE TABLE categories RESTART IDENTITY CASCADE');

    const categories = Object.keys(CATEGORY_IMAGES);

    console.log('Seeding categories with realistic local images...');
    for (const cat of categories) {
      const imgUrl = CATEGORY_IMAGES[cat];
      await pool.query(
        'INSERT INTO categories (name, models, image_url) VALUES ($1, $2, $3)',
        [cat, '[]', imgUrl]
      );
    }

    const materials = ['22k Gold', '18k Rose Gold', 'Platinum', 'Sterling Silver', 'Diamond', 'Kundan', 'Polki'];
    const adjectives = ['Exquisite', 'Elegant', 'Royal', 'Bridal', 'Classic', 'Minimalist', 'Timeless', 'Statement', 'Vintage'];

    console.log('Generating products with perfectly generated local images...');
    const allProducts = [];

    for (const cat of categories) {
      for (let i = 1; i <= 10; i++) {
        const material = materials[Math.floor(Math.random() * materials.length)];
        const adjective = adjectives[Math.floor(Math.random() * adjectives.length)];
        const catSingular = cat.endsWith('s') ? cat.slice(0, -1) : cat;
        const name = `${adjective} ${material} ${catSingular}`;
        const description = `This is a beautifully crafted ${name}, perfect for adding a touch of elegance to your attire. Handcrafted by master artisans with precision and care, this piece is a testament to the luxurious heritage of Manikanta Super Market.`;
        
        const is_bestseller = Math.random() < 0.3;
        const is_trending = Math.random() < 0.3;
        const is_festive = Math.random() < 0.3;
        const is_offer = Math.random() < 0.2;

        const basePrice = Math.floor(Math.random() * 80000) + 15000; // 15k to 95k

        const imageUrl = CATEGORY_IMAGES[cat];

        allProducts.push({
          name,
          description,
          category: cat,
          color: material,
          price: basePrice,
          image_url: imageUrl,
          images: [imageUrl, imageUrl], // Use the same image twice for gallery to not break it
          is_bestseller,
          is_trending,
          is_festive,
          is_offer
        });
      }
    }

    console.log(`Inserting ${allProducts.length} jewelry products...`);
    for (const p of allProducts) {
      const sizesJson = JSON.stringify([
        { size: 'Standard', price: p.price }
      ]);
      const imagesJson = JSON.stringify(p.images);
      
      await pool.query(
        'INSERT INTO products (name, description, sizes, stock, image_url, images, color, category, is_active, is_bestseller, is_trending, is_festive, is_offer) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)',
        [p.name, p.description, sizesJson, 50, p.image_url, imagesJson, p.color, p.category, true, p.is_bestseller, p.is_trending, p.is_festive, p.is_offer]
      );
    }

    console.log('✅ Local Image Jewelry seeding complete!');
    process.exit(0);
  } catch (err) {
    console.error('❌ Seeding failed:', err.message);
    process.exit(1);
  }
}

seedJewelry();
