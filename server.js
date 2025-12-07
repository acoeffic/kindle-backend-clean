import express from 'express';
import { chromium } from 'playwright';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Stockage temporaire (remplacer par une vraie DB en production)
let booksData = [];

// Fonction de scraping Kindle
async function scrapeKindleData(email, password) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  console.log('Browser lancé, création du contexte...');
  
  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    });
    const page = await context.newPage();
    
    console.log('Navigation vers Amazon...');

    // 1. Connexion à Amazon
    await page.goto('https://www.amazon.com/ap/signin?openid.return_to=https://read.amazon.com/notebook', { waitUntil: 'networkidle' });
    
    console.log('Page de connexion chargée');
    
    // Attendre le formulaire de connexion
    await page.waitForSelector('input[type="email"]', { timeout: 10000 });
    await page.fill('input[type="email"]', email);
    await page.click('#continue');
    
    console.log('Email saisi, attente password...');
    
    await page.waitForTimeout(2000);
    await page.waitForSelector('input[type="password"]', { timeout: 10000 });
    await page.fill('input[type="password"]', password);
    await page.click('#signInSubmit');

    console.log('Connexion soumise, attente redirection...');

    // Attendre la redirection vers notebook
    await page.waitForURL('**/notebook**', { timeout: 30000 });
    await page.waitForLoadState('networkidle');
    
    console.log('Sur la page notebook, recherche des livres...');
    console.log('URL actuelle:', page.url());
    
    // Attendre que les livres soient chargés
    try {
      await page.waitForSelector('.kp-notebook-library-each-book', { timeout: 15000 });
      console.log('Sélecteur trouvé !');
    } catch (e) {
      console.log('Sélecteur non trouvé, extraction du HTML...');
      const html = await page.content();
      console.log('Début du HTML:', html.substring(0, 1000));
    }
    
    await page.waitForTimeout(3000);

    // Extraire les données des livres
    const books = await page.evaluate(() => {
      const bookElements = document.querySelectorAll('.kp-notebook-library-each-book');
      const results = [];
      
      console.log('Nombre de livres trouvés:', bookElements.length);

      bookElements.forEach((book, index) => {
        try {
          const titleEl = book.querySelector('.kp-notebook-searchable');
          const authorEl = book.querySelectorAll('.kp-notebook-searchable')[1];
          const coverEl = book.querySelector('img');
          
          if (titleEl) {
            results.push({
              title: titleEl?.textContent?.trim() || 'Unknown',
              author: authorEl?.textContent?.trim() || 'Unknown',
              cover: coverEl?.src || '',
              id: book.getAttribute('id') || `book-${index}`,
              scrapedAt: new Date().toISOString()
            });
          }
        } catch (err) {
          console.error(`Erreur pour le livre ${index}:`, err.message);
        }
      });

      return results;
    });
    
    console.log(`${books.length} livres extraits`);

    // 3. Pour chaque livre, récupérer les highlights et progression
    for (let book of books) {
      try {
        // Cliquer sur le livre pour voir les détails
        const bookSelector = `#${book.id}`;
        await page.click(bookSelector);
        await page.waitForTimeout(2000);

        // Extraire highlights et notes
        const highlights = await page.evaluate(() => {
          const highlightEls = document.querySelectorAll('.kp-notebook-highlight');
          return Array.from(highlightEls).map(el => ({
            text: el.querySelector('.kp-notebook-highlight-text')?.textContent?.trim() || '',
            location: el.querySelector('.kp-notebook-metadata')?.textContent?.trim() || '',
            note: el.querySelector('.kp-notebook-note-text')?.textContent?.trim() || null
          }));
        });

        book.highlights = highlights;
        book.highlightCount = highlights.length;
        
        // Retour à la liste
        await page.goBack();
        await page.waitForTimeout(1000);
      } catch (err) {
        console.error(`Erreur pour le livre ${book.title}:`, err.message);
        book.highlights = [];
        book.highlightCount = 0;
      }
    }

    return books;

  } catch (error) {
    console.error('Erreur scraping:', error);
    throw error;
  } finally {
    await browser.close();
  }
}

// Routes API

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Synchroniser les données Kindle
app.post('/api/sync', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email et password requis' });
  }

  try {
    console.log('Démarrage du scraping...');
    const books = await scrapeKindleData(email, password);
    booksData = books;
    
    res.json({
      success: true,
      message: `${books.length} livres synchronisés`,
      books: books,
      syncedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error('Erreur sync:', error);
    res.status(500).json({ 
      error: 'Erreur lors de la synchronisation',
      details: error.message 
    });
  }
});

// Récupérer tous les livres
app.get('/api/books', (req, res) => {
  res.json({
    books: booksData,
    count: booksData.length,
    lastSync: booksData[0]?.scrapedAt || null
  });
});

// Récupérer un livre spécifique
app.get('/api/books/:id', (req, res) => {
  const book = booksData.find(b => b.id === req.params.id);
  
  if (!book) {
    return res.status(404).json({ error: 'Livre non trouvé' });
  }
  
  res.json(book);
});

// Statistiques de lecture
app.get('/api/stats', (req, res) => {
  const totalBooks = booksData.length;
  const totalHighlights = booksData.reduce((acc, book) => acc + (book.highlightCount || 0), 0);
  
  res.json({
    totalBooks,
    totalHighlights,
    averageHighlightsPerBook: totalBooks > 0 ? (totalHighlights / totalBooks).toFixed(2) : 0,
    mostHighlightedBook: booksData.sort((a, b) => 
      (b.highlightCount || 0) - (a.highlightCount || 0)
    )[0] || null
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Serveur démarré sur le port ${PORT}`);
  console.log(`📚 API disponible sur http://localhost:${PORT}/api`);
});
