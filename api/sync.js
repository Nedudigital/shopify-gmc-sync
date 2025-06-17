require('dotenv').config();
const axios = require('axios');
const { google } = require('googleapis');

const {
  SHOPIFY_STORE_DOMAIN,
  SHOPIFY_ADMIN_API_TOKEN,
  BUNDLE_TAG,
  GMC_CLIENT_ID,
  GMC_CLIENT_SECRET,
  GMC_REFRESH_TOKEN,
  GMC_MERCHANT_ID
} = process.env;

const SHOPIFY_API_VERSION = '2024-04';

const oAuth2Client = new google.auth.OAuth2(
  GMC_CLIENT_ID,
  GMC_CLIENT_SECRET,
  'http://localhost:3000'
);
oAuth2Client.setCredentials({ refresh_token: GMC_REFRESH_TOKEN });

async function getAccessToken() {
  const { token } = await oAuth2Client.getAccessToken();
  return token;
}

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

    const bundleProducts = res.data.products.filter(prod =>
      prod.tags.split(',').map(tag => tag.trim().toLowerCase()).includes(BUNDLE_TAG)
    );
    products.push(...bundleProducts);

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

function buildGmcProduct(shopifyProduct) {
  const variant = shopifyProduct.variants[0];
  const image = shopifyProduct.images && shopifyProduct.images[0] ? shopifyProduct.images[0].src : '';
  const hasBarcode = variant.barcode && variant.barcode.trim() !== '';
  let description = (shopifyProduct.body_html || '').replace(/<[^>]*>?/gm, '');

  return {
    offerId: variant.sku || `shopify-${shopifyProduct.id}`,
    title: shopifyProduct.title,
    description: description,
    link: `https://${SHOPIFY_STORE_DOMAIN}/products/${shopifyProduct.handle}`,
    imageLink: image,
    availability: (typeof variant.inventory_quantity !== 'undefined' && variant.inventory_quantity > 0) ? 'in stock' : 'out of stock',
    price: {
      value: variant.price,
      currency: 'USD'
    },
    brand: shopifyProduct.vendor || 'YourBrand',
    gtin: hasBarcode ? variant.barcode : undefined,
    identifierExists: hasBarcode,
    contentLanguage: 'en',
    targetCountry: 'US',
    condition: 'new',
  };
}

async function pushBundlesToGmc(products) {
  const accessToken = await getAccessToken();
  const gmcApi = axios.create({
    baseURL: 'https://shoppingcontent.googleapis.com/content/v2.1/',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    }
  });

  let results = [];

  for (let product of products) {
    const gmcProduct = buildGmcProduct(product);
    try {
      await gmcApi.post(
        `${GMC_MERCHANT_ID}/products`,
        {
          ...gmcProduct,
          channel: 'online',
        }
      );
      results.push(`Pushed: ${gmcProduct.title}`);
    } catch (err) {
      if (err.response && err.response.status === 409) {
        await gmcApi.patch(
          `${GMC_MERCHANT_ID}/products/online:en:US:${gmcProduct.offerId}`,
          gmcProduct
        );
        results.push(`Updated: ${gmcProduct.title}`);
      } else {
        results.push(`Error for ${gmcProduct.title}: ${err.response ? JSON.stringify(err.response.data) : err.message}`);
      }
    }
  }
  return results;
}

// Vercel serverless function handler:
module.exports = async (req, res) => {
  try {
    const bundles = await getShopifyBundles();
    if (!bundles.length) {
      return res.status(200).send('No bundles found with the specified tag.');
    }
    const results = await pushBundlesToGmc(bundles);
    return res.status(200).json({ status: 'Done syncing bundles!', details: results });
  } catch (err) {
    return res.status(500).json({ error: err.message || err });
  }
};
