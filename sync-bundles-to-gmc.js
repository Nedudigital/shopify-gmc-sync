require('dotenv').config();
const axios = require('axios');
const { google } = require('googleapis');

// ENV variables
const {
  SHOPIFY_STORE_DOMAIN,
  SHOPIFY_ADMIN_API_TOKEN,
  BUNDLE_TAG,
  GMC_CLIENT_ID,
  GMC_CLIENT_SECRET,
  GMC_REFRESH_TOKEN,
  GMC_MERCHANT_ID
} = process.env;

const SHOPIFY_API_VERSION = '2024-04'; // Use your store's current API version

// Google Auth setup
const oAuth2Client = new google.auth.OAuth2(
  GMC_CLIENT_ID,
  GMC_CLIENT_SECRET,
  'http://localhost:3000'
);
oAuth2Client.setCredentials({ refresh_token: GMC_REFRESH_TOKEN });

// Get Google API access token
async function getAccessToken() {
  const { token } = await oAuth2Client.getAccessToken();
  return token;
}

// 1. Pull all bundle products from Shopify
async function getShopifyBundles() {
  let products = [];
  let endpoint = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/products.json?limit=250&fields=id,title,body_html,variants,images,product_type,tags,vendor,handle`;
  let morePages = true;
  let pageInfo = null;

  while (morePages) {
    let url = endpoint;
    if (pageInfo) url += `&page_info=${pageInfo}`;

    const res = await axios.get(url, {
      headers: {
        'X-Shopify-Access-Token': SHOPIFY_ADMIN_API_TOKEN,
      }
    });

    // Filter for products with the BUNDLE_TAG
    const bundleProducts = res.data.products.filter(prod =>
      prod.tags.split(',').map(tag => tag.trim().toLowerCase()).includes(BUNDLE_TAG)
    );

    products.push(...bundleProducts);

    // Pagination: break loop if no more pages
    const linkHeader = res.headers['link'];
    if (linkHeader && linkHeader.includes('rel="next"')) {
      const match = linkHeader.match(/page_info=([^&>]+)/);
      pageInfo = match ? match[1] : null;
      morePages = !!pageInfo;
    } else {
      morePages = false;
    }
  }
  return products;
}

// 2. Build GMC product objects
function buildGmcProduct(shopifyProduct) {
  const variant = shopifyProduct.variants[0]; // default to first variant
  const image = shopifyProduct.images && shopifyProduct.images[0] ? shopifyProduct.images[0].src : '';
  const hasBarcode = variant.barcode && variant.barcode.trim() !== '';

  // Basic description, stripped of HTML
let description = (shopifyProduct.body_html || '').replace(/<[^>]*>?/gm, '');
  // You can append more details here if needed

  return {
    offerId: variant.sku || `shopify-${shopifyProduct.id}`,
    title: shopifyProduct.title,
    description: description,
    link: `https://${SHOPIFY_STORE_DOMAIN}/products/${shopifyProduct.handle}`,
    imageLink: image,
    availability: (typeof variant.inventory_quantity !== 'undefined' && variant.inventory_quantity > 0) ? 'in stock' : 'out of stock',
    price: {
      value: variant.price,
      currency: 'USD' // Change if your store is not in USD
    },
    brand: shopifyProduct.vendor || 'YourBrand',
    gtin: hasBarcode ? variant.barcode : undefined,
    identifierExists: hasBarcode,
    contentLanguage: 'en',
    targetCountry: 'US',
    condition: 'new',
    // Add more GMC fields if needed
  };
}

// 3. Push/update bundles to GMC
async function pushBundlesToGmc(products) {
  const accessToken = await getAccessToken();
  const gmcApi = axios.create({
    baseURL: 'https://shoppingcontent.googleapis.com/content/v2.1/',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    }
  });

  for (let product of products) {
    const gmcProduct = buildGmcProduct(product);
    try {
      // Insert or update the product in GMC
      await gmcApi.post(
        `${GMC_MERCHANT_ID}/products`,
        {
          ...gmcProduct,
          channel: 'online',
        }
      );
      console.log(`Pushed bundle: ${gmcProduct.title}`);
    } catch (err) {
      // If already exists, update (patch)
      if (err.response && err.response.status === 409) {
        await gmcApi.patch(
          `${GMC_MERCHANT_ID}/products/online:en:US:${gmcProduct.offerId}`,
          gmcProduct
        );
        console.log(`Updated bundle: ${gmcProduct.title}`);
      } else {
        console.error(`Error for ${gmcProduct.title}:`, err.response ? err.response.data : err.message);
      }
    }
  }
}

// Main run
(async () => {
  try {
    const bundles = await getShopifyBundles();
    if (!bundles.length) {
      console.log('No bundles found with the specified tag.');
      return;
    }
    await pushBundlesToGmc(bundles);
    console.log('Done syncing bundles!');
  } catch (err) {
    console.error('Sync error:', err);
  }
})();
