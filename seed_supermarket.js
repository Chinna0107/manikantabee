const pool = require('./db');

async function seed() {
  try {
    console.log('Clearing existing categories and products...');
    await pool.query('TRUNCATE TABLE products RESTART IDENTITY CASCADE');
    await pool.query('TRUNCATE TABLE categories RESTART IDENTITY CASCADE');

    const categories = [
      { name: 'Fresh Fruits & Vegetables', image_url: 'https://images.unsplash.com/photo-1610348725531-843dff563e2c?w=500&auto=format&fit=crop' },
      { name: 'Dairy & Bakery', image_url: 'https://images.unsplash.com/photo-1628088062854-d1870b4553da?w=500&auto=format&fit=crop' },
      { name: 'Snacks & Beverages', image_url: 'https://images.unsplash.com/photo-1621506289937-a8e4df240d0b?w=500&auto=format&fit=crop' },
      { name: 'Rice, Atta & Dals', image_url: 'https://images.unsplash.com/photo-1586201375761-83865001e31c?w=500&auto=format&fit=crop' },
      { name: 'Household & Cleaning', image_url: 'https://images.unsplash.com/photo-1584820927498-cafe3c0b1bb6?w=500&auto=format&fit=crop' }
    ];

    console.log('Seeding categories...');
    for (const cat of categories) {
      await pool.query(
        'INSERT INTO categories (name, models, image_url) VALUES ($1, $2, $3)',
        [cat.name, '[]', cat.image_url]
      );
    }

    console.log('Seeding products...');
    const productsData = [
      {
        name: 'Organic Bananas',
        description: 'Fresh and naturally ripened organic bananas.',
        category: 'Fresh Fruits & Vegetables',
        color: 'Yellow',
        price: 60,
        sizes: [{ size: '500g', price: 60 }, { size: '1kg', price: 110 }],
        image_url: 'https://images.unsplash.com/photo-1571771894821-ce9b6c11b08e?w=500&auto=format&fit=crop'
      },
      {
        name: 'Fresh Farm Apples',
        description: 'Crisp and sweet fresh farm apples.',
        category: 'Fresh Fruits & Vegetables',
        color: 'Red',
        price: 150,
        sizes: [{ size: '500g', price: 150 }, { size: '1kg', price: 280 }],
        image_url: 'https://images.unsplash.com/photo-1560806887-1e4cd0b6faa6?w=500&auto=format&fit=crop'
      },
      {
        name: 'Whole Wheat Bread',
        description: 'Soft and healthy 100% whole wheat bread.',
        category: 'Dairy & Bakery',
        color: 'Brown',
        price: 45,
        sizes: [{ size: '200g', price: 25 }, { size: '400g', price: 45 }],
        image_url: 'https://images.unsplash.com/photo-1509440159596-0249088772ff?w=500&auto=format&fit=crop'
      },
      {
        name: 'Fresh Cow Milk',
        description: 'Pure and fresh pasteurized cow milk. Rich in calcium and protein.',
        category: 'Dairy & Bakery',
        color: 'White',
        price: 35,
        sizes: [{ size: '500ml', price: 35 }, { size: '1L', price: 68 }, { size: '2L', price: 130 }],
        image_url: 'https://images.unsplash.com/photo-1550583724-b2692b85b150?w=500&auto=format&fit=crop'
      },
      {
        name: 'Amul Butter',
        description: 'Creamy, rich pasteurized butter made from fresh cream.',
        category: 'Dairy & Bakery',
        color: 'Yellow',
        price: 55,
        sizes: [{ size: '100g', price: 55 }, { size: '500g', price: 255 }],
        image_url: 'https://images.unsplash.com/photo-1589985270826-4b7bb135bc9d?w=500&auto=format&fit=crop'
      },
      {
        name: 'Brown Eggs',
        description: 'Farm fresh free range brown eggs rich in omega-3.',
        category: 'Dairy & Bakery',
        color: 'Brown',
        price: 90,
        sizes: [{ size: '6 pcs', price: 50 }, { size: '12 pcs', price: 90 }, { size: '30 pcs', price: 220 }],
        image_url: 'https://images.unsplash.com/photo-1582722872445-44dc5f7e3c8f?w=500&auto=format&fit=crop'
      },
      // Snacks & Beverages
      {
        name: 'Potato Chips Classic',
        description: 'Crunchy, lightly salted classic potato chips. Perfect party snack.',
        category: 'Snacks & Beverages',
        color: 'Yellow',
        price: 20,
        sizes: [{ size: '50g', price: 20 }, { size: '150g', price: 50 }, { size: '250g', price: 80 }],
        image_url: 'https://images.unsplash.com/photo-1566478989037-eec170784d0b?w=500&auto=format&fit=crop'
      },
      {
        name: 'Mixed Fruit Juice',
        description: 'Refreshing natural mixed fruit juice with no added preservatives.',
        category: 'Snacks & Beverages',
        color: 'Orange',
        price: 45,
        sizes: [{ size: '250ml', price: 25 }, { size: '500ml', price: 45 }, { size: '1L', price: 80 }],
        image_url: 'https://images.unsplash.com/photo-1600271886742-f049cd451bba?w=500&auto=format&fit=crop'
      },
      {
        name: 'Dark Chocolate Bar',
        description: '70% cocoa rich dark chocolate bar, perfect for gifting.',
        category: 'Snacks & Beverages',
        color: 'Brown',
        price: 150,
        sizes: [{ size: '50g', price: 80 }, { size: '100g', price: 150 }],
        image_url: 'https://images.unsplash.com/photo-1606312619070-d48b4c652a52?w=500&auto=format&fit=crop'
      },
      {
        name: 'Mineral Water',
        description: 'Pure packaged drinking water from natural springs.',
        category: 'Snacks & Beverages',
        color: 'Clear',
        price: 20,
        sizes: [{ size: '500ml', price: 15 }, { size: '1L', price: 20 }, { size: '2L', price: 35 }],
        image_url: 'https://images.unsplash.com/photo-1548839140-29a749e1cf4d?w=500&auto=format&fit=crop'
      },
      // Rice, Atta & Dals
      {
        name: 'Premium Basmati Rice',
        description: 'Long grain, aromatic premium basmati rice for special occasions.',
        category: 'Rice, Atta & Dals',
        color: 'White',
        price: 250,
        sizes: [{ size: '1kg', price: 250 }, { size: '5kg', price: 1100 }, { size: '10kg', price: 2100 }],
        image_url: 'https://images.unsplash.com/photo-1536304929831-ee1ca9d44906?w=500&auto=format&fit=crop'
      },
      {
        name: 'Whole Wheat Atta',
        description: '100% whole wheat flour, stone-ground for maximum nutrition.',
        category: 'Rice, Atta & Dals',
        color: 'Beige',
        price: 200,
        sizes: [{ size: '1kg', price: 70 }, { size: '5kg', price: 200 }, { size: '10kg', price: 380 }],
        image_url: 'https://images.unsplash.com/photo-1574323347407-f5e1ad6d020b?w=500&auto=format&fit=crop'
      },
      {
        name: 'Toor Dal (Yellow)',
        description: 'Premium quality split pigeon peas, rich in protein and easy to cook.',
        category: 'Rice, Atta & Dals',
        color: 'Yellow',
        price: 120,
        sizes: [{ size: '500g', price: 65 }, { size: '1kg', price: 120 }, { size: '5kg', price: 580 }],
        image_url: 'https://images.unsplash.com/photo-1585996765851-a0e88cae85c5?w=500&auto=format&fit=crop'
      },
      {
        name: 'Moong Dal (Green)',
        description: 'Whole green moong dal — high protein, excellent for sprouting.',
        category: 'Rice, Atta & Dals',
        color: 'Green',
        price: 130,
        sizes: [{ size: '500g', price: 70 }, { size: '1kg', price: 130 }, { size: '5kg', price: 620 }],
        image_url: 'https://images.unsplash.com/photo-1614961907487-8c6b63a06be2?w=500&auto=format&fit=crop'
      },
      // Fresh Fruits & Vegetables
      {
        name: 'Organic Spinach',
        description: 'Fresh, crisp organic spinach leaves — perfect for salads and cooking.',
        category: 'Fresh Fruits & Vegetables',
        color: 'Green',
        price: 30,
        sizes: [{ size: '200g', price: 30 }, { size: '500g', price: 65 }],
        image_url: 'https://images.unsplash.com/photo-1580910051074-3eb694886505?w=500&auto=format&fit=crop'
      },
      {
        name: 'Sweet Mango Alphonso',
        description: 'King of mangoes — the Alphonso! Naturally ripened, sweet and aromatic.',
        category: 'Fresh Fruits & Vegetables',
        color: 'Yellow',
        price: 350,
        sizes: [{ size: '500g', price: 180 }, { size: '1kg', price: 350 }, { size: '2kg', price: 680 }],
        image_url: 'https://images.unsplash.com/photo-1601493700631-2b16ec4b4716?w=500&auto=format&fit=crop'
      },
      {
        name: 'Cherry Tomatoes',
        description: 'Juicy and sweet cherry tomatoes, perfect for salads and pasta.',
        category: 'Fresh Fruits & Vegetables',
        color: 'Red',
        price: 60,
        sizes: [{ size: '250g', price: 35 }, { size: '500g', price: 60 }, { size: '1kg', price: 110 }],
        image_url: 'https://images.unsplash.com/photo-1557800636-894a64c1696f?w=500&auto=format&fit=crop'
      },
      {
        name: 'Fresh Pomegranate',
        description: 'Ruby-red pomegranate seeds, rich in antioxidants.',
        category: 'Fresh Fruits & Vegetables',
        color: 'Red',
        price: 180,
        sizes: [{ size: '500g', price: 100 }, { size: '1kg', price: 180 }],
        image_url: 'https://images.unsplash.com/photo-1621987543049-0f70e62b5d20?w=500&auto=format&fit=crop'
      },
      // Household & Cleaning
      {
        name: 'Floor Cleaner Lemon',
        description: 'Strong antibacterial floor cleaner with fresh lemon scent.',
        category: 'Household & Cleaning',
        color: 'Yellow',
        price: 180,
        sizes: [{ size: '500ml', price: 100 }, { size: '1L', price: 180 }, { size: '2L', price: 340 }],
        image_url: 'https://images.unsplash.com/photo-1585421514738-01798e348b17?w=500&auto=format&fit=crop'
      },
      {
        name: 'Dish Wash Liquid',
        description: 'Powerful grease-cutting dish wash liquid with aloe vera.',
        category: 'Household & Cleaning',
        color: 'Green',
        price: 90,
        sizes: [{ size: '200ml', price: 45 }, { size: '500ml', price: 90 }, { size: '1L', price: 165 }],
        image_url: 'https://images.unsplash.com/photo-1585664811087-47f65abbad64?w=500&auto=format&fit=crop'
      },
      {
        name: 'Laundry Detergent',
        description: 'High-efficiency front-load laundry detergent, gentle on colors.',
        category: 'Household & Cleaning',
        color: 'Blue',
        price: 320,
        sizes: [{ size: '1kg', price: 180 }, { size: '3kg', price: 320 }, { size: '6kg', price: 600 }],
        image_url: 'https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=500&auto=format&fit=crop'
      }
    ];

    for (const p of productsData) {
      const sizesJson = JSON.stringify(p.sizes);
      const imagesJson = JSON.stringify([p.image_url]);
      
      await pool.query(
        'INSERT INTO products (name, description, sizes, stock, image_url, images, color, category, is_active, is_bestseller) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
        [p.name, p.description, sizesJson, 100, p.image_url, imagesJson, p.color, p.category, true, Math.random() > 0.6]
      );
    }

    console.log('✅ Seeding complete!');
    process.exit(0);
  } catch (err) {
    console.error('❌ Seeding failed:', err.message);
    process.exit(1);
  }
}

seed();
