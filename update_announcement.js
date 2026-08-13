const pool = require('./db');

async function updateAnnouncement() {
  try {
    const value = {
      is_active: true,
      items: [
        { text: "Free shipping on orders above $100", link: "" },
        { text: "Welcome to Manikanta Super Market!", link: "" }
      ]
    };
    await pool.query("UPDATE settings SET value = $1 WHERE key = 'announcement'", [JSON.stringify(value)]);
    console.log("Updated announcement successfully.");
    process.exit(0);
  } catch (err) {
    console.error("Error updating:", err);
    process.exit(1);
  }
}

updateAnnouncement();
