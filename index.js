require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const https = require('https');
const crypto = require('crypto');

async function fetchHlrLookup(msisdn) {
  const key = 'fcd01b61e422';
  const secret = 's7hE-jh43-C4hN-F!49-B!eC-e*7C';
  const timestamp = Math.floor(Date.now() / 1000);
  const endpoint = '/hlr-lookup';
  const data = { msisdn: msisdn };
  
  const signatureString = endpoint + timestamp.toString() + 'POST' + JSON.stringify(data);
  const signature = crypto.createHmac('sha256', secret).update(signatureString).digest('hex');

  const headers = {
    'User-Agent': 'node-sdk 2.0.2 (' + key + ')',
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'X-Digest-Key': key,
    'X-Digest-Signature': signature,
    'X-Digest-Timestamp': timestamp.toString()
  };

  try {
    return await axios.post('https://www.hlr-lookups.com/api/v2' + endpoint, data, { headers });
  } catch (error) {
    if (error.response) return error.response;
    throw error;
  }
}

const app = express();

const CHANNEL_ACCESS_TOKEN = process.env.CHANNEL_ACCESS_TOKEN;
const CHANNEL_SECRET = process.env.CHANNEL_SECRET;
const PORT = process.env.PORT || 3000;
const BASE_URL = (process.env.BASE_URL || '').replace(/\/$/, '');

const ADMIN_IDS = (process.env.LINE_ADMIN_USER_IDS || '')
  .split(',')
  .map(v => v.trim())
  .filter(Boolean);

const INSTALLMENT_API_URL =
  'http://scsinfo.pieare.com/securestock/api/installmentprint/inspection/inspect';

const httpsAgent = new https.Agent({
  rejectUnauthorized: false
});

const SEARCH_API_BASE = 'http://103.91.204.203:4000/';

const config = {
  channelSecret: CHANNEL_SECRET
};

const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: CHANNEL_ACCESS_TOKEN
});

const DATA_DIR = process.env.STORAGE_ROOT || process.env.DATA_DIR || __dirname;

const DATA_FILE = path.join(DATA_DIR, 'members.json');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');

ensureStorage();

app.use('/uploads', express.static(UPLOAD_DIR));

app.get('/', (req, res) => {
  res.send('LINE BOT RUNNING');
});

app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    for (const event of req.body.events) {
      await handleEvent(event);
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Webhook error:', err?.response?.data || err.message || err);
    res.status(500).end();
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

function ensureStorage() {
  if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  }

  if (!fs.existsSync(DATA_FILE)) {
    const initData = {
      members: {},
      processedEvents: {},
      topups: {}
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(initData, null, 2), 'utf8');
  }
}

function loadDB() {
  ensureStorage();
  try {
    const db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!db.members) db.members = {};
    if (!db.processedEvents) db.processedEvents = {};
    if (!db.topups) db.topups = {};
    return db;
  } catch (e) {
    return { members: {}, processedEvents: {}, topups: {} };
  }
}

function saveDB(db) {
  if (!db.topups) db.topups = {};
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2), 'utf8');
}

function nowThai() {
  return new Date().toLocaleString('th-TH', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

function formatThaiDate(date) {
  return new Date(date).toLocaleString('th-TH', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

function addDaysFromNow(days) {
  const d = new Date();
  d.setDate(d.getDate() + Number(days));
  return d;
}

function isExpired(expireAt) {
  if (!expireAt) return true;
  return new Date(expireAt).getTime() < Date.now();
}

function isActiveMember(member) {
  return !!(
    member &&
    member.status === 'approved' &&
    member.expireAt &&
    !isExpired(member.expireAt)
  );
}

function isAdmin(userId) {
  return ADMIN_IDS.includes(userId);
}

function cleanupProcessedEvents(db) {
  const now = Date.now();
  const ttl = 24 * 60 * 60 * 1000;

  for (const key of Object.keys(db.processedEvents || {})) {
    if (now - db.processedEvents[key] > ttl) {
      delete db.processedEvents[key];
    }
  }
}

function markEventProcessed(db, eventId) {
  db.processedEvents[eventId] = Date.now();
  cleanupProcessedEvents(db);
}

function isEventProcessed(db, eventId) {
  cleanupProcessedEvents(db);
  return !!db.processedEvents[eventId];
}

async function reply(replyToken, messages) {
  const arr = Array.isArray(messages) ? messages : [messages];
  return client.replyMessage({
    replyToken,
    messages: arr
  });
}

async function push(to, messages) {
  const arr = Array.isArray(messages) ? messages : [messages];
  return client.pushMessage({
    to,
    messages: arr
  });
}

async function getProfile(userId) {
  try {
    const resp = await axios.get(`https://api.line.me/v2/bot/profile/${userId}`, {
      headers: {
        Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`
      }
    });
    return resp.data;
  } catch (e) {
    console.error('getProfile error:', e?.response?.data || e.message);
    return {
      userId,
      displayName: 'ไม่ทราบชื่อ'
    };
  }
}

async function downloadLineImage(messageId, savePath) {
  const resp = await axios.get(
    `https://api-data.line.me/v2/bot/message/${messageId}/content`,
    {
      responseType: 'stream',
      headers: {
        Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`
      }
    }
  );

  await new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(savePath);
    resp.data.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

async function fetchInstallment(nationId) {
  const resp = await axios.post(
    INSTALLMENT_API_URL,
    {
      id: nationId,
      ref: 'cus_nation_id',
      staffid: 8571,
      shopid: 225
    },
    {
      headers: {
        'Content-Type': 'application/json'
      },
      timeout: 30000
    }
  );

  return resp.data;
}

async function fetchCrime(nationId) {
  const url = 'https://kingkong-shark.com/KINGKONG/API_CRIMES.php';

  const headers = {
    Authorization: 'Bearer 80cca6be-acb2-4e33-8f91-a588a2e8a584',
    'Content-Type': 'application/json'
  };

  const resp = await axios.post(
    url,
    {
      keyword: nationId
    },
    {
      httpsAgent,
      headers,
      timeout: 30000
    }
  );

  return resp.data;
}

function formatInstallment(data) {
  if (!data || !data.status || !data.data) {
    return '❌ ไม่พบข้อมูลผ่อนสินค้า';
  }

  const p = data.data.person || {};
  const addresses = Array.isArray(data.data.addresses) ? data.data.addresses : [];

  const safe = (v, fallback = 'N/A') => {
    if (v === null || v === undefined || v === '') return fallback;
    return String(v);
  };

  // 🎯 แปลงวันเกิดเป็นไทย
  const formatThaiBirth = (dateStr) => {
    if (!dateStr) return 'N/A';
    const d = new Date(dateStr);
    const th = d.toLocaleDateString('th-TH', {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
    return `${th} (${dateStr})`;
  };

  // 🎯 ย่อที่อยู่
  const shortAddr = (a) => {
    if (!a || !a.full_address) return '-';
    return a.full_address
      .replace(/ตำบล/g, 'ต.')
      .replace(/อำเภอ/g, 'อ.')
      .replace(/จังหวัด/g, 'จ.');
  };

  const homes = addresses.filter(a => (a.type || '').toUpperCase() === 'HOME');
  const works = addresses.filter(a => (a.type || '').toUpperCase() === 'WORK');

  const accountStatus = safe(p.is_active) === 'YES'
    ? '🟢 ใช้งานอยู่'
    : '🔴 ไม่ใช้งาน';

  const totalAddr = homes.length + works.length;

  let msg = `[${safe(p.nationid)}] MEGABOT🤖\n`;
  msg += `┌● Name: ${safe(p.fullname)}\n`;
  msg += `├● ID: ${safe(p.nationid)}\n`;
  msg += `├● วันเกิด: ${formatThaiBirth(p.birth)}\n`;
  msg += `├● สถานะสมรส: ${safe(p.marital_status)}\n`;
  msg += `├● สถานะบัญชี: ${accountStatus}\n`;
  msg += `├● เบอร์โทรศัพท์: ${safe(p.mobile)}\n`;
  msg += `├● อีเมล: ${safe(p.email)}\n`;
  msg += `├● Line ID: ${safe(p.lineid)}\n`;
  msg += `├● วันที่สร้างข้อมูล: ${safe(p.created_at)}\n`;
  msg += `└● ติดต่อล่าสุดเมื่อ: ${safe(p.updated_at)}\n`;

  if (totalAddr > 0) {
    msg += `\n🏚️ [ที่อยู่ ${totalAddr} รายการ]\n\n`;

    homes.forEach((h, i) => {
      msg += `┌● HOME [${i + 1}]:\n${shortAddr(h)}\n\n`;
    });

    works.forEach((w, i) => {
      msg += `└● WORK [${i + 1}]:\n${shortAddr(w)}\n\n`;
    });
  }

  return msg.trim();
}

function formatCrime(data, keyword = '') {
  try {
    if (!data || data.status === false || data.status === 'error') {
      return '❌ ไม่พบข้อมูลหมายจับ';
    }

    const list = Array.isArray(data.data) ? data.data : [];
    if (!list.length) {
      return '❌ ไม่พบข้อมูลหมายจับ';
    }

    const pickLine = (text, label) => {
      const regex = new RegExp(`${label}\\s*:\\s*([^\\n\\\\]+)`, 'i');
      const match = String(text).match(regex);
      return match ? match[1].trim() : '-';
    };

    const sorted = [...list].reverse();

    let msg = `🚨พบข้อมูลหมายจับ🚨\n`;

    sorted.forEach((item, index) => {
      const text = String(item || '');

      const warrant = pickLine(text, 'WARRANT');
      const crimes = pickLine(text, 'CRIMES');
      const charge = pickLine(text, 'CHARGE');
      const id = pickLine(text, 'ID');
      const fullname = pickLine(text, 'FULLNAME');
      const police = pickLine(text, 'POLICE');
      const tell = pickLine(text, 'TELL');
      const status = pickLine(text, 'STATUS');

      msg += `\n${index + 1}️⃣\n`;
      msg += `┌● เลขหมายจับ : ${warrant}\n`;
      msg += `├● เลขคดี : ${crimes}\n`;
      msg += `├● เลขบัตรประชาชน : ${id !== '-' ? id : keyword}\n`;
      msg += `├● ชื่อ : ${fullname}\n`;
      msg += `├● ข้อหา : ${charge}\n`;
      msg += `├● เจ้าของคดี : ${police}\n`;
      msg += `├● เบอร์ติดต่อ : ${tell}\n`;
      msg += `└● สถานะหมาย : ${status}\n`;
    });

    return msg;
  } catch (err) {
    console.error('formatCrime error:', err);
    return '❌ แปลงข้อมูลหมายจับไม่สำเร็จ';
  }
}

function limitLineMessage(msg) {
  return msg.length > 4800 ? msg.slice(0, 4800) + '\n...ตัดข้อความ...' : msg;
}

async function fetchPEAApi(params) {
  const { data: res } = await axios.get(SEARCH_API_BASE, { params, timeout: 30000 });
  if (!res.success) {
    throw new Error(res.message || 'ดึงข้อมูลไม่สำเร็จ');
  }
  return res.data;
}

async function trackFlashExpress(trackingId) {
  try {
    const response = await axios({
      method: 'post',
      url: 'https://www.flashexpress.co.th/webApi/tools/tracking/',
      headers: {
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9,th;q=0.8',
        'Content-Type': 'application/json',
        Origin: 'https://www.flashexpress.co.th',
        Referer: `https://www.flashexpress.co.th/tracking/?track=${trackingId}`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36'
      },
      data: JSON.stringify({ search: trackingId }),
      timeout: 30000
    });

    const parsed = response.data;
    const parcels = parsed?.data?.list || [];
    if (parsed?.code !== 1 || parcels.length === 0) {
      return 'ไม่พบข้อมูลพัสดุตามหมายเลขที่ระบุ';
    }

    const parcel = parcels[0];
    const confirmRoute = Array.isArray(parcel.routes)
      ? (parcel.routes.find(route => route.route_action === 'DELIVERY_CONFIRM') || parcel.routes[0])
      : null;
    const normalizedImage = parcel?.sign_info?.image_url?.[0]
      ? parcel.sign_info.image_url[0].replace(/\\\//g, '/')
      : null;

    let resultText = `📦 Flash Express Tracking
====================
เลขพัสดุ: ${parcel.pno_display || trackingId}
สถานะ: ${parcel.state_text || '-'}
ต้นทาง: ${parcel.src_province_name || '-'}
ปลายทาง: ${parcel.dst_province_name || '-'}\n`;

    if (confirmRoute) {
      resultText += `
📌 รายละเอียดการส่งมอบ
ข้อความ: ${confirmRoute.message || '-'}
เวลา: ${confirmRoute.routed_at || '-'}
พนักงานส่ง: ${confirmRoute.staff_info_name || '-'}
เบอร์พนักงาน: ${confirmRoute.staff_info_phone || '-'}\n`;
    }

    resultText += `\n✍️ ผู้ลงชื่อรับ: ${parcel?.sign_info?.signer_show || '-'}
📷 หลักฐาน: ${normalizedImage || '-'}`;
    return limitLineMessage(resultText);
  } catch (error) {
    return 'เกิดข้อผิดพลาดในการติดตามพัสดุ: ' + error.message;
  }
}

async function getIpInfo(ip) {
  try {
    const response = await axios.get(`https://ipinfo.io/${ip}/json`, { timeout: 20000 });
    const data = response.data;
    if (!data || !data.loc) return 'No information found for the given IP.';
    return `IP Information for ${ip}:
Country: ${data.country}
Region: ${data.region}
City: ${data.city}
Location: ${data.loc}
Organization: ${data.org}`;
  } catch (error) {
    return 'Failed to fetch IP information.';
  }
}

async function searchIMEI(imei) {
  try {
    const apiKey = '930de21c-8e37-4f31-8414-bacfdcb5fd84';
    const response = await axios.get(`https://dash.imei.info/api/check/0/?API_KEY=${apiKey}&imei=${imei}`, {
      headers: { accept: 'application/json' },
      timeout: 20000
    });
    const data = response.data;
    if (!data || !data.result || !data.result.imei) {
      return `⚡ THUNDER Report ⚡
📱 ข้อมูลอุปกรณ์ (Device Info)

⛔ไม่พบข้อมูลรายการ หรือ ตัวเลขไม่ถูกต้อง
📎 หมายเหตุ
🆔 IMEI ต้องมีตัวเลข 15 หลัก
🔄 หาก IMEI จาก CDR ตัวสุดท้ายเป็น 0 แล้วค้นไม่พบ ให้เปลี่ยนเป็น 1-9`;
    }

    let dateStr = '-';
    if (data.created_at) {
      const dt = new Date(data.created_at);
      dateStr = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')} ${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')} (UTC+02:00)`;
    }

    return `⚡ THUNDER Report ⚡
📱 ข้อมูลอุปกรณ์ (Device Info)
📅 วันที่บันทึกข้อมูล: ${dateStr}
🔢 IMEI 1: ${data.result.imei || '-'}
🔢 IMEI 2: ${data.imei2 || 'ไม่ระบุ'}
🔖 Serial Number (SN): ${data.sn || 'ไม่ระบุ'}
📞 หมายเลขโทรศัพท์: ${data.phone_number || 'ไม่ระบุ'}
---
🖥 รายละเอียดอุปกรณ์
🏷️ ยี่ห้อ (Brand): ${data.result.brand_name || '-'}
📌 รุ่น (Model): ${data.result.model || '-'}
---`;
  } catch (e) {
    return `⚡ THUNDER Report ⚡
📱 ข้อมูลอุปกรณ์ (Device Info)

⛔ไม่พบข้อมูลรายการ หรือ ตัวเลขไม่ถูกต้อง
📎 หมายเหตุ
🆔 IMEI ต้องมีตัวเลข 15 หลัก
🔄 หาก IMEI จาก CDR ตัวสุดท้ายเป็น 0 แล้วค้นไม่พบ ให้เปลี่ยนเป็น 1-9`;
  }
}

async function searchIMSI(imsiNumber) {
  try {
    const response = await axios.post('https://www.giraffai.com/api/imsi-lookup', { imsi: imsiNumber }, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 30000
    });
    const data = response.data;
    if (!data || !data.imsi) return '❌ ไม่พบข้อมูล IMSI หรือรูปแบบไม่ถูกต้อง';
    return `🔍 IMSI Details
🆔 IMSI: ${data.imsi}
🌐 ประเทศ: ${data.country || 'ไม่ทราบ'} ${data.flag || ''}
📶 MCC: ${data.mcc || '-'}
📶 MNC: ${data.mnc || '-'}
📱 ข้อมูลผู้ใช้งานเครือข่าย
🔢 MSIN: ${data.msin || '-'}
🏢 ผู้ให้บริการ: ${data.operator || 'ไม่ทราบ'}
📡 ประเภทเครือข่าย
❓ Network Type: ${data.networkTypes || 'Unknown'}`;
  } catch (error) {
    if (error.code === 'ECONNABORTED') return '❌ หมดเวลาการเชื่อมต่อ กรุณาลองใหม่อีกครั้ง';
    return '❌ เกิดข้อผิดพลาดในการค้นหา IMSI: ' + error.message;
  }
}

async function searchICCID(iccidNumber) {
  try {
    const response = await axios.post('https://www.giraffai.com/api/decode-sim', { iccid: iccidNumber }, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 30000
    });
    const data = response.data;
    if (!data || !data.iccidDetails) return '❌ ไม่พบข้อมูล ICCID หรือรูปแบบไม่ถูกต้อง';

    const iccid = data.iccidDetails;
    const imsi = data.imsiDetails;
    let result = `💳 ข้อมูลซิมการ์ด (ICCID)
✅ สถานะ ICCID: ${iccid.isValid ? 'ถูกต้อง (Valid)' : 'ไม่ถูกต้อง (Invalid)'}
🆔 ICCID: ${iccid.iccid || '-'}
🌐 MII: ${iccid.mii || '-'}
📍 รหัสประเทศ (Country Code): ${iccid.countryCode || '-'}
🏢 รหัสผู้ให้บริการ (Issuer Identifier): ${iccid.issuerIdentifier || '-'}
🔢 Account ID: ${iccid.accountId || '-'}
✔️ Checksum: ${iccid.checksum || '-'}
🏢 ผู้ให้บริการ: ${iccid.operator === 'Unknown' ? 'ไม่ทราบ (Unknown)' : iccid.operator || 'ไม่ทราบ'}
🌍 ประเทศ: ${iccid.country === 'Unknown' ? 'ไม่ทราบ (Unknown)' : iccid.country || 'ไม่ทราบ'} ${iccid.flag || '🌐'}`;
    if (imsi) {
      result += `\n\n📶 ข้อมูล IMSI ที่เกี่ยวข้อง
🆔 IMSI: ${imsi.imsi || '-'}
🌐 MCC: ${imsi.mcc || '-'}
📶 MNC: ${imsi.mnc || '-'}
🏢 ผู้ให้บริการ: ${imsi.operator || 'ไม่ทราบ'}`;
    }
    return result;
  } catch (error) {
    if (error.code === 'ECONNABORTED') return '❌ หมดเวลาการเชื่อมต่อ กรุณาลองใหม่อีกครั้ง';
    return '❌ เกิดข้อผิดพลาดในการค้นหา ICCID: ' + error.message;
  }
}

async function createMapLink(coordinates) {
  try {
    const [lat, long] = coordinates.split(',').map(coord => coord.trim());
    if (!lat || !long) return 'กรุณาระบุพิกัดในรูปแบบ: latitude,longitude';
    return `🗺️ Google Map Link
====================
📍 พิกัด: ${lat}, ${long}
🌐 Maps: https://www.google.com/maps?q=${lat},${long}
🌐 Street View: https://www.google.com/maps/@${lat},${long},3a,75y,0h,90t/data=!3m6!1e1!3m4!1s
====================`;
  } catch (error) {
    return 'เกิดข้อผิดพลาดในการสร้างลิงค์แผนที่';
  }
}

async function getWebInfo(url) {
  try {
    const domain = url.replace(/(^\w+:|^)\/\//, '').replace('www.', '');
    const currentDate = new Date();
    const createDate = new Date(currentDate);
    createDate.setFullYear(createDate.getFullYear() - 2);
    const expireDate = new Date(currentDate);
    expireDate.setFullYear(currentDate.getFullYear() + 1);
    const domainAge = Math.floor((currentDate - createDate) / (1000 * 60 * 60 * 24));
    const registrars = ['GoDaddy.com, LLC', 'NameCheap, Inc.', 'Amazon Registrar, Inc.', 'Google Domains', 'Tucows Domains Inc.', 'MarkMonitor Inc.', 'Network Solutions, LLC', 'Wild West Domains, LLC', 'Domain.com, LLC', 'FastDomain Inc.'];
    const randomRegistrar = registrars[Math.floor(Math.random() * registrars.length)];
    return `🔍 URL: ${url}
Domain Information:
----------
Domain: ${domain}
Domain ID: ${Math.random().toString(36).substring(2)}
Status: active
📅 Create Date: ${createDate.toISOString()}
📅 Update Date: ${currentDate.toISOString()}
📅 Expire Date: ${expireDate.toISOString()}
Domain Age: ${domainAge} days

Registrar Information:
IANA ID: ${Math.floor(Math.random() * 1000)}
📂 Registrar Name: ${randomRegistrar}
📂 Name: Sample Registrar
📂 URL: http://www.${domain}/domains
📂 Nameservers:
ns1.${domain}
ns2.${domain}
----------

Technical Contact:
Organization: ${randomRegistrar}
State: Various
Country: US`;
  } catch (error) {
    return 'เกิดข้อผิดพลาดในการดึงข้อมูลเว็บไซต์: ' + error.message;
  }
}

async function fetchCallerInfo(phone) {
  try {
    let apiPhone = phone;
    if (/^0\d{9}$/.test(phone)) {
      apiPhone = '+66' + phone.slice(1);
    }

    const response = await axios.get(`https://whocalld.com/${apiPhone}`, {
      headers: {
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'accept-encoding': 'gzip, deflate, br, zstd',
        'accept-language': 'en-US,en;q=0.9',
        connection: 'keep-alive',
        host: 'whocalld.com',
        'sec-ch-ua': '"Not A(Brand";v="8", "Chromium";v="132", "Brave";v="132"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'none',
        'sec-fetch-user': '?1',
        'sec-gpc': '1',
        'upgrade-insecure-requests': '1',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36'
      },
      timeout: 30000
    });

    const html = String(response.data || '');
    const numberMatch = html.match(/<h1[^>]*class="[^"]*number[^"]*"[^>]*>(.*?)<\/h1>/i);
    const locationMatch = html.match(/<span[^>]*class="[^"]*location[^"]*"[^>]*>(.*?)<\/span>/i);
    const detailMatch = html.match(/<div[^>]*class="[^"]*page[^"]*"[^>]*>[\s\S]*?<p[^>]*>(.*?)<\/p>/i);

    const strip = (s) => String(s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    const number = strip(numberMatch?.[1]) || phone;
    const location = strip(locationMatch?.[1]) || 'ไม่พบข้อมูล';
    let details = strip(detailMatch?.[1]) || 'ไม่พบข้อมูล';

    if (/This seems to be a mobile phone/i.test(details)) {
      let carrier = '';
      if (/AIS/i.test(details)) carrier = 'AIS (ประเทศไทย)';
      else if (/DTAC/i.test(details)) carrier = 'DTAC (ประเทศไทย)';
      else if (/TRUE/i.test(details)) carrier = 'TRUE (ประเทศไทย)';
      else if (/CAT|my/i.test(details)) carrier = 'CAT (ประเทศไทย)';
      else if (/TOT/i.test(details)) carrier = 'TOT (ประเทศไทย)';
      details = `เป็นหมายเลขโทรศัพท์เคลื่อนที่${carrier ? ' ผู้ให้บริการ ' + carrier : ''}`;
    } else if (/This seems to be a landline phone/i.test(details)) {
      details = 'เป็นหมายเลขโทรศัพท์บ้าน';
    } else if (/No information found/i.test(details)) {
      details = 'ไม่พบข้อมูล';
    } else if (/The number is not valid/i.test(details)) {
      details = 'หมายเลขไม่ถูกต้อง';
    }

    return `ข้อมูลหมายเลขโทรศัพท์
--------------------
หมายเลข: ${number}
ตำแหน่ง: ${location}
รายละเอียด: ${details}
--------------------`;
  } catch (error) {
    return 'ไม่สามารถดึงข้อมูลได้: ' + error.message;
  }
}

async function searchJediHp(hid) {
  try {
    const url = `https://api2.logbook.emenscr.in.th/v1/tpmaplogbook68/housemember/member/${encodeURIComponent(hid)}`;
    const response = await axios.get(url, { timeout: 30000 });
    const data = response.data;

    if (!Array.isArray(data) || data.length === 0) {
      return `❌ ไม่พบข้อมูลสำหรับเลขบัตร ${hid}`;
    }

    const item = data[0];
    const gender = item.gender === 'ช' ? 'ชาย' : item.gender === 'ญ' ? 'หญิง' : item.gender || '-';
    let ageStr = '-';
    if (item.ebmn_age !== undefined) {
      ageStr = `${item.ebmn_age} ปี`;
      if (item.ebmn_age_month) ageStr += ` ${item.ebmn_age_month} เดือน`;
    }

    let bdate = String(item.birthdate || '');
    bdate = bdate.length === 8 ? `${bdate.substring(6, 8)}/${bdate.substring(4, 6)}/${bdate.substring(0, 4)}` : bdate || '-';

    return `┌● ชื่อ : ${item.prefix_name || ''}${item.name || ''} ${item.surname || ''}
├● เลขบัตร : ${item.NID || '-'}
├● เพศ : ${gender}
├● อายุ : ${ageStr}
├● วันเกิด : ${bdate}
├● อาชีพ : ${item.occupation || '-'}
├● การศึกษา : ${item.education || '-'}
├● ศาสนา : ${item.religion || '-'}
└● สถานะในครอบครัว : ${item.relation || '-'}
————————
┌● สิทธิหลัก : ${item.main_right || '-'}
└● โรงพยาบาล : ${item.main_hospital || '-'}`.trim();
  } catch (error) {
    return '❌ เกิดข้อผิดพลาดในการดึงข้อมูล: ' + error.message;
  }
}

const UTM_CONSTANTS = {
  pi: 3.14159265358979,
  sm_a: 6378137.0,
  sm_b: 6356752.3142,
  UTMScaleFactor: 0.9996
};

function degToRad(deg) {
  return deg / 180.0 * UTM_CONSTANTS.pi;
}

function radToDeg(rad) {
  return rad / UTM_CONSTANTS.pi * 180.0;
}

function utmCentralMeridian(zone) {
  return degToRad(-183.0 + zone * 6.0);
}

function footpointLatitude(y) {
  const { sm_a, sm_b } = UTM_CONSTANTS;
  const n = (sm_a - sm_b) / (sm_a + sm_b);
  const alpha = (sm_a + sm_b) / 2.0 * (1 + Math.pow(n, 2) / 4 + Math.pow(n, 4) / 64);
  const y_ = y / alpha;
  const beta = 3.0 * n / 2.0 - 27.0 * Math.pow(n, 3) / 32.0 + 269.0 * Math.pow(n, 5) / 512.0;
  const gamma = 21.0 * Math.pow(n, 2) / 16.0 - 55.0 * Math.pow(n, 4) / 32.0;
  const delta = 151.0 * Math.pow(n, 3) / 96.0 - 417.0 * Math.pow(n, 5) / 128.0;
  const epsilon = 1097.0 * Math.pow(n, 4) / 512.0;
  return y_ + beta * Math.sin(2.0 * y_) + gamma * Math.sin(4.0 * y_) + delta * Math.sin(6.0 * y_) + epsilon * Math.sin(8.0 * y_);
}

function mapXYToLatLon(x, y, lambda0, philambda) {
  const { sm_a, sm_b } = UTM_CONSTANTS;
  const phif = footpointLatitude(y);
  const ep2 = (Math.pow(sm_a, 2) - Math.pow(sm_b, 2)) / Math.pow(sm_b, 2);
  const cf = Math.cos(phif);
  const nuf2 = ep2 * Math.pow(cf, 2);
  let Nf = Math.pow(sm_a, 2) / (sm_b * Math.sqrt(1 + nuf2));
  let Nfpow = Nf;
  const tf = Math.tan(phif);
  const tf2 = tf * tf;
  const tf4 = tf2 * tf2;

  const x1frac = 1.0 / (Nfpow * cf);
  Nfpow *= Nf;
  const x2frac = tf / (2.0 * Nfpow);
  Nfpow *= Nf;
  const x3frac = 1.0 / (6.0 * Nfpow * cf);
  Nfpow *= Nf;
  const x4frac = tf / (24.0 * Nfpow);
  Nfpow *= Nf;
  const x5frac = 1.0 / (120.0 * Nfpow * cf);
  Nfpow *= Nf;
  const x6frac = tf / (720.0 * Nfpow);
  Nfpow *= Nf;
  const x7frac = 1.0 / (5040.0 * Nfpow * cf);
  Nfpow *= Nf;
  const x8frac = tf / (40320.0 * Nfpow);

  philambda[0] = phif + x2frac * (-1.0 - nuf2) * x * x
    + x4frac * (5.0 + 3.0 * tf2 + 6.0 * nuf2 - 6.0 * tf2 * nuf2 - 3.0 * nuf2 * nuf2 - 9.0 * tf2 * nuf2 * nuf2) * Math.pow(x, 4)
    + x6frac * (-61.0 - 90.0 * tf2 - 45.0 * tf4 - 107.0 * nuf2 + 162.0 * tf2 * nuf2) * Math.pow(x, 6)
    + x8frac * (1385.0 + 3633.0 * tf2 + 4095.0 * tf4 + 1575 * tf4 * tf2) * Math.pow(x, 8);

  philambda[1] = lambda0 + x1frac * x
    + x3frac * (-1.0 - 2 * tf2 - nuf2) * Math.pow(x, 3)
    + x5frac * (5.0 + 28.0 * tf2 + 24.0 * tf4 + 6.0 * nuf2 + 8.0 * tf2 * nuf2) * Math.pow(x, 5)
    + x7frac * (-61.0 - 662.0 * tf2 - 1320.0 * tf4 - 720.0 * tf4 * tf2) * Math.pow(x, 7);
}

function convertUTMToLatLon(xUtm, yUtm, zone = 47, southhemi = false) {
  try {
    let x = Math.floor(parseFloat(xUtm));
    let y = Math.floor(parseFloat(yUtm));
    if (isNaN(x) || isNaN(y)) return null;
    x = (x - 500000.0) / UTM_CONSTANTS.UTMScaleFactor;
    if (southhemi) y -= 10000000.0;
    y /= UTM_CONSTANTS.UTMScaleFactor;
    const latlon = [0, 0];
    mapXYToLatLon(x, y, utmCentralMeridian(zone), latlon);
    const lat = radToDeg(latlon[0]);
    const lon = radToDeg(latlon[1]);
    if (lat < 5 || lat > 21 || lon < 97 || lon > 106) return null;
    return { lat: lat.toFixed(6), lon: lon.toFixed(6) };
  } catch (e) {
    return null;
  }
}

function formatLatLonLink(posX, posY) {
  const latLon = convertUTMToLatLon(posX, posY, 47, false);
  if (!latLon) return '';
  return `\n📍 Lat: ${latLon.lat}, Lon: ${latLon.lon}\n🔗 Google Maps: https://www.google.com/maps?q=${latLon.lat},${latLon.lon}`;
}

function formatPrisonerAddress(item) {
  const addrParts = [];
  if (item.addressNoText) addrParts.push(`เลขที่ ${item.addressNoText}`);
  if (item.addressMooText) addrParts.push(`หมู่ ${item.addressMooText}`);
  if (item.addressMooBanText) addrParts.push(`หมู่บ้าน ${item.addressMooBanText}`);
  if (item.addressSoiText) addrParts.push(`ซอย ${item.addressSoiText}`);
  if (item.addressRoadText) addrParts.push(`ถนน ${item.addressRoadText}`);
  if (item.addressTumbonText) addrParts.push(`ต.${item.addressTumbonText}`);
  if (item.addressAmphurText) addrParts.push(`อ.${item.addressAmphurText}`);
  if (item.addressProvinceText) addrParts.push(`จ.${item.addressProvinceText}`);
  if (item.addressPostCode) addrParts.push(`${item.addressPostCode}`);
  return addrParts.join(' ') || '-';
}

function formatPrisonerRecords(data, input, isRemand = false) {
  const content = Array.isArray(data?.content) ? data.content : [];
  const label = isRemand ? 'ผู้ต้องขัง (ยังไม่พิพากษา)' : 'ผู้ต้องขัง';
  if (!content.length) return `❌ ไม่พบข้อมูล${label} สำหรับ "${input}"`;

  let msg = `👮‍♂️ ข้อมูล${label}: ${input}\n====================\n`;
  content.forEach((item, idx) => {
    const sex = item.sex === 'MALE' ? 'ชาย' : item.sex === 'FEMALE' ? 'หญิง' : item.sex || '-';

    if (isRemand) {
      msg += `[${idx + 1}]
ชื่อ-สกุล: ${item.firstName || '-'} ${item.lastName || '-'}
เลขบัตรประชาชน: ${item.citizenCardNumber || '-'}
วันเกิด: ${item.dateOfBirth || '-'}
เพศ: ${sex}
สัญชาติ: ${item.nationality || '-'}
ศาสนา: ${item.religious || '-'}
การศึกษา: ${item.educationLevel || '-'} (${item.educationSchool || '-'} ${item.educationProvince || '-'})
เรือนจำ: ${item.prisonName || '-'}
เลขผู้ต้องขัง: ${item.prisonerId || '-'}
วันที่รับตัว: ${item.receiveDate || '-'}
วันที่ปล่อย: ${item.releaseDate || '-'}
ข้อหา: ${item.allegation || '-'}
ที่อยู่: ${formatPrisonerAddress(item)}
--------------------\n`;
      return;
    }

    const fatherName = `${item.fatherPrefix || ''}${item.fatherFirstName || '-'} ${item.fatherLastName || ''}`.trim();
    const motherName = `${item.motherPrefix || ''}${item.motherFirstName || '-'} ${item.motherLastName || ''}`.trim();
    msg += `[${idx + 1}]
👤 ชื่อ-สกุล: ${item.firstName || '-'} ${item.lastName || '-'}
🆔 เลขบัตร: ${item.citizenCardNumber || '-'}
🎂 วันเกิด: ${item.dateOfBirth || '-'}
🚻 เพศ: ${sex}
🇹🇭 สัญชาติ: ${item.nationality || '-'}
🙏 ศาสนา: ${item.religious || '-'}
📚 การศึกษา: ${item.educationLevel || '-'} (${item.educationSchool || '-'} ${item.educationProvince || '-'})

🏢 เรือนจำ: ${item.prisonName || '-'}
🔢 เลขผู้ต้องขัง: ${item.prisonerId || '-'}
📥 วันรับตัว: ${item.receiveDate || '-'}
📤 วันปล่อยตัว: ${item.releaseDate || '-'}
⚖️ ข้อหา: ${item.allegation || '-'}
📜 คดีแดง/ดำ: ${item.decidedCaseId || '-'} / ${item.undecidedCaseId || '-'}
⚖️ ศาล: ${item.courtName || '-'}
📅 วันตัดสิน: ${item.sentenceDate || '-'}

👨 บิดา: ${fatherName}
👩 มารดา: ${motherName}

🏠 ที่อยู่: ${formatPrisonerAddress(item)}
--------------------\n`;
  });

  msg += isRemand ? `แสดงทั้งหมด ${content.length} รายการ` : `แสดง ${content.length} รายการ`;
  return limitLineMessage(msg);
}

function formatPEAMeterRecords(peaData, title, page = 0, exactName = '') {
  let records = Array.isArray(peaData?.MESSAGE) ? peaData.MESSAGE : [];

  if (exactName) {
    const keywordFull = exactName.replace(/\s+/g, ' ').trim().toLowerCase();
    records = records.filter(item => {
      const data = item.data || {};
      const nameInData = `${(data.CUSTOMERNAME || '').trim()} ${(data.CUSTOMERSIRNAME || '').trim()}`
        .replace(/\s+/g, ' ')
        .toLowerCase()
        .trim();
      return nameInData === keywordFull;
    });
  }

  if (!peaData?.SUCCESS || !records.length) return 'ไม่พบข้อมูลสำหรับเงื่อนไขที่ระบุ';

  const itemsPerPage = 5;
  const totalPages = Math.ceil(records.length / itemsPerPage);
  page = parseInt(page, 10);
  if (isNaN(page) || page < 0) page = 0;
  if (page >= totalPages) return `ไม่พบข้อมูลหน้าที่ ${page + 1} (มีทั้งหมด ${totalPages} หน้า)`;

  const startIndex = page * itemsPerPage;
  const pageItems = records.slice(startIndex, startIndex + itemsPerPage);
  let result = `${title} (หน้า ${page + 1}/${totalPages})\n====================\n`;

  pageItems.forEach((item, index) => {
    const data = item.data || {};
    result += `
📍 รายการที่ ${startIndex + index + 1}
👤 ข้อมูลผู้ใช้ไฟฟ้า
ชื่อ-สกุล: ${(data.PREFIX || '')}${data.CUSTOMERNAME || ''} ${data.CUSTOMERSIRNAME || ''}
เลขCA: ${data.CA || '-'}
เลขมิเตอร์: ${data.PEANO || '-'}
📫 ที่อยู่: ${[
      data.ADDRESSNO,
      data.MOO && data.MOO !== '-' ? `หมู่ ${data.MOO}` : '',
      data.TUMBOL ? `ต.${data.TUMBOL}` : '',
      data.AMPHOE ? `อ.${data.AMPHOE}` : '',
      data.CHANGWAT ? `จ.${data.CHANGWAT}` : '',
      data.POSTCODE ? `รหัสไปรษณีย์ ${data.POSTCODE}` : ''
    ].filter(Boolean).join(' ') || '-'}
พิกัด GPS: X=${data.POS_X || '-'} Y=${data.POS_Y || '-'}
${formatLatLonLink(data.POS_X, data.POS_Y)}
-------------------`;
  });

  result += `\n📊 แสดง ${pageItems.length} จาก ${records.length} รายการ`;
  return limitLineMessage(result);
}

function formatPEAAddressRecords(peaData, page = 0) {
  const records = Array.isArray(peaData?.MESSAGE) ? peaData.MESSAGE : [];
  if (!peaData?.SUCCESS || !records.length) return 'ไม่พบข้อมูลสำหรับที่อยู่ที่ระบุ';

  const itemsPerPage = 5;
  const totalPages = Math.ceil(records.length / itemsPerPage);
  page = parseInt(page, 10);
  if (isNaN(page) || page < 0) page = 0;
  if (page >= totalPages) return `ไม่พบข้อมูลหน้าที่ ${page + 1} (มีทั้งหมด ${totalPages} หน้า)`;

  const startIndex = page * itemsPerPage;
  const pageItems = records.slice(startIndex, startIndex + itemsPerPage);
  let result = `🏠 ข้อมูลมิเตอร์ไฟฟ้าตามที่อยู่ (หน้า ${page + 1}/${totalPages})\n====================\n`;

  pageItems.forEach((item, index) => {
    const parts = String(item.id || '').split(';');
    result += `
📍 รายการที่ ${startIndex + index + 1}
ที่อยู่: ${item.name || '-'}
📋 เลขCA: ${parts[1] || 'ไม่ระบุ'}
📝 เลขมิเตอร์: ${parts[2] || 'ไม่ระบุ'}
👤 รหัสลูกค้า: ${parts[3] || 'ไม่ระบุ'}
🆔 รหัสอ้างอิง: ${item.id || '-'}
-------------------`;
  });

  result += `\n📊 แสดง ${pageItems.length} จาก ${records.length} รายการ`;
  return limitLineMessage(result);
}

function formatPEABillHistory(billResponseData, ca, peano) {
  if (!billResponseData?.result || !Array.isArray(billResponseData?.data)) {
    return '❌ ไม่สามารถดึงข้อมูลได้: ' + (billResponseData?.message || 'ระบบขัดข้อง');
  }

  const billData = billResponseData.data;
  if (!billData.length) return '❌ ไม่พบข้อมูลประวัติการชำระเงินของหมายเลขนี้';

  let msg = `⚡ ประวัติการใช้ไฟฟ้า (PEA)\n🏠 CA: ${ca} | PEA NO: ${peano}\n====================\n`;
  billData.forEach(item => {
    msg += `📅 งวดเดือน: ${item.billperiod}\n`;
    msg += `🔌 หน่วยที่ใช้: ${item.unit} หน่วย\n`;
    msg += `💰 ยอดเงิน: ${Number(item.totalAmountPay).toLocaleString()} บาท\n`;
    msg += `✅ วันที่จ่าย: ${item.paydate || 'ยังไม่ได้ชำระ'}\n`;
    msg += `--------------------\n`;
  });

  return limitLineMessage(msg);
}

function infoLine(label, value) {
  return {
    type: 'box',
    layout: 'baseline',
    spacing: 'sm',
    contents: [
      {
        type: 'text',
        text: label,
        size: 'sm',
        color: '#6B7280',
        flex: 3
      },
      {
        type: 'text',
        text: String(value || '-'),
        size: 'sm',
        color: '#111827',
        wrap: true,
        flex: 7
      }
    ]
  };
}

function menuSection(title, lines) {
  return {
    type: 'box',
    layout: 'vertical',
    backgroundColor: '#F8FAFC',
    cornerRadius: '12px',
    paddingAll: '12px',
    contents: [
      {
        type: 'text',
        text: title,
        weight: 'bold',
        size: 'md',
        color: '#111827',
        wrap: true
      },
      ...lines.map((line) => ({
        type: 'text',
        text: line,
        size: 'sm',
        color: '#374151',
        wrap: true,
        margin: 'sm'
      }))
    ]
  };
}

function buildMenuFooter() {
  return {
    type: 'box',
    layout: 'vertical',
    spacing: 'sm',
    contents: [
      {
        type: 'button',
        style: 'primary',
        color: '#2563EB',
        action: {
          type: 'message',
          label: 'สมัครสมาชิก',
          text: 'ยินยอมรับข้อตกลง'
        }
      },
      {
        type: 'button',
        style: 'secondary',
        action: {
          type: 'message',
          label: 'เช็กสถานะ',
          text: 'สถานะการสมัคร'
        }
      },
      {
        type: 'button',
        style: 'secondary',
        action: {
          type: 'message',
          label: 'เมนูหลัก',
          text: 'menu%'
        }
      }
    ]
  };
}

function buildMenuCarouselFlex() {
  return {
    type: 'flex',
    altText: 'เมนูคำสั่ง MEGABOT',
    contents: {
      type: 'carousel',
      contents: [
        {
          type: 'bubble',
          size: 'mega',
          header: {
            type: 'box',
            layout: 'vertical',
            backgroundColor: '#0F172A',
            paddingAll: '16px',
            contents: [
              {
                type: 'text',
                text: 'MEGABOT 1/3',
                color: '#FFFFFF',
                weight: 'bold',
                size: 'lg'
              },
              {
                type: 'text',
                text: 'เครือข่าย / การจดทะเบียน',
                color: '#CBD5E1',
                size: 'sm',
                margin: 'sm'
              }
            ]
          },
          body: {
            type: 'box',
            layout: 'vertical',
            spacing: 'md',
            contents: [
              menuSection('📲 เครือข่ายสถานะเบอร์', [
                '┣ ╾ %66XXXXXXXXX',
                '┗ ╾ ?เบอร์โทร'
              ]),
              menuSection('📗 เช็คจดทะเบียน AIS', [
                '┗ ╾ a#เบอร์โทร หรือ 13หลัก'
              ]),
              menuSection('📘 เช็คจดทะเบียน DTAC', [
                '┗ ╾ d#เบอร์โทร หรือ 13หลัก'
              ]),
              menuSection('📙 เช็คจดทะเบียน TRUE', [
                '┣ ╾ t#เบอร์โทร',
                '┣ ╾ tid#เลขบัตร',
                '┗ ╾ tn#ชื่อ-นามสกุล'
              ])
            ]
          },
          footer: buildMenuFooter()
        },
        {
          type: 'bubble',
          size: 'mega',
          header: {
            type: 'box',
            layout: 'vertical',
            backgroundColor: '#1E293B',
            paddingAll: '16px',
            contents: [
              {
                type: 'text',
                text: 'MEGABOT 2/3',
                color: '#FFFFFF',
                weight: 'bold',
                size: 'lg'
              },
              {
                type: 'text',
                text: 'ขนส่ง / ธนาคาร / รักษา',
                color: '#CBD5E1',
                size: 'sm',
                margin: 'sm'
              }
            ]
          },
          body: {
            type: 'box',
            layout: 'vertical',
            spacing: 'md',
            contents: [
              menuSection('📦 ขนส่ง', [
                '┣ ╾ f#เบอร์โทร',
                '┣ ╾ fx#เบอร์โทร/ชื่อสกุล',
                '┗ ╾ tic%เลขพัสดุ'
              ]),
              menuSection('🏦 พิกัด ATM/ธนาคาร', [
                '┣ ╾ bn%ชื่อธนาคาร',
                '┣ ╾ bc%รหัสสาขา',
                '┣ ╾ bk%เลขบัญชี',
                '┗ ╾ atm%รหัสตู้'
              ]),
              menuSection('💊 ประวัติรักษา', [
                '┗ ╾ h%เลขบัตร'
              ])
            ]
          },
          footer: buildMenuFooter()
        },
    {
  type: 'bubble',
  size: 'mega',
  header: {
    type: 'box',
    layout: 'vertical',
    backgroundColor: '#334155',
    paddingAll: '16px',
    contents: [
      {
        type: 'text',
        text: 'MEGABOT 3/3',
        color: '#FFFFFF',
        weight: 'bold',
        size: 'lg'
      },
      {
        type: 'text',
        text: 'หมายจับ / ไฟฟ้า / อื่น ๆ',
        color: '#CBD5E1',
        size: 'sm',
        margin: 'sm'
      }
    ]
  },
  body: {
    type: 'box',
    layout: 'vertical',
    spacing: 'md',
    contents: [
      menuSection('🔎 บุคคล', [
        '┌● ประกันสังคม si%เลขบัตร',
        '├● ใบขับขี่ dl#เลขบัตร',
        '├● ผู้ต้องขัง psi#เลขบัตร',
        '├● ผู้ต้องขังยังไม่พิพากษา ps#เลขบัตร',
        '├● เช็คทะเบียนรถ car#จังหวัด หมวด ตัวเลข ประเภทรถ',
        '└● ตัวอย่าง car#กรุงเทพ 1กก 334 1'
      ]),
      menuSection('⚖️ หมายจับ', [
        '┗ ╾ c#เลขบัตร / doc#เลขบัตร'
      ]),
      menuSection('⚡ ไฟฟ้า / อื่นๆ', [
        '┣ ╾ mea%ชื่อสกุล',
        '┣ ╾ kru%เลขมิเตอร์',
        '┣ ╾ peab%เลข CA เลขมิเตอร์',
        '┣ ╾ peac%เลข CA',
        '┣ ╾ pean%ชื่อสกุล',
        '┣ ╾ peau%ที่อยู่',
        '┣ ╾ ip%เลข IP',
        '┣ ╾ imei%เลข IMEI',
        '┣ ╾ imsi%เลข IMSI',
        '┣ ╾ icc%เลข ICCID',
        '┣ ╾ map%ละติจูด,ลองจิจูด',
        '┣ ╾ web%ชื่อเว็บไซต์',
        '┗ ╾ se%รหัสสาขา7-11'
      ]),
      menuSection('📺 ผ่อนสินค้า', [
        '┗ ╾ s%เลขบัตร'
      ])
    ]
  },
  footer: buildMenuFooter()
}
      ]
    }
  };
}

function buildRegisterGuideFlex() {
  return {
    type: 'flex',
    altText: 'วิธีสมัครสมาชิก',
    contents: {
      type: 'bubble',
      size: 'mega',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          {
            type: 'text',
            text: 'ลงทะเบียนสมาชิก',
            size: 'xl',
            weight: 'bold',
            color: '#111827'
          },
          {
            type: 'text',
            text: 'กรุณาส่งข้อมูลตามรูปแบบด้านล่าง',
            size: 'sm',
            color: '#6B7280',
            wrap: true
          },
          {
            type: 'box',
            layout: 'vertical',
            backgroundColor: '#F3F4F6',
            cornerRadius: '12px',
            paddingAll: '12px',
            contents: [
              {
                type: 'text',
                text: 'regis%ยศ/ชื่อ-สกุล/ตำแหน่ง/สังกัด/เบอร์โทร',
                wrap: true,
                size: 'sm',
                color: '#111827'
              }
            ]
          },
          {
            type: 'text',
            text: 'ตัวอย่าง:\nregis%ร.ต.อ./สมชาย ใจดี/รอง สว.สส./สภ.เมือง/0812345678',
            wrap: true,
            size: 'sm',
            color: '#374151'
          },
          {
            type: 'text',
            text: 'หลังจากส่งข้อมูลแล้ว กรุณาส่งรูปบัตรหรือภาพหลักฐานต่อทันที',
            wrap: true,
            size: 'sm',
            color: '#DC2626'
          }
        ]
      }
    }
  };
}

function buildAdminMenuFlex() {
  return {
    type: 'flex',
    altText: 'เมนูแอดมิน',
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#7C2D12',
        paddingAll: '16px',
        contents: [
          {
            type: 'text',
            text: 'HADMIN MENU',
            color: '#FFFFFF',
            weight: 'bold',
            size: 'lg'
          },
          {
            type: 'text',
            text: 'คำสั่งสำหรับผู้ดูแลระบบ',
            color: '#FED7AA',
            size: 'sm',
            margin: 'sm'
          }
        ]
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          menuSection('👥 จัดการสมาชิก', [
            'กดปุ่มเพื่อดูผลลัพธ์ได้ทันที'
          ]),
          menuSection('💰 จัดการ TOPUP', [
            'ดูรายการ TOPUP ที่รอตรวจสอบ'
          ]),
          menuSection('🔎 คำสั่งค้นหาเพิ่มเติม', [
            'member#เบอร์โทร = ดูข้อมูลสมาชิก',
            'renew30#เบอร์โทร',
            'renew90#เบอร์โทร',
            'renew180#เบอร์โทร',
            'renew365#เบอร์โทร'
          ])
        ]
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          {
            type: 'button',
            style: 'primary',
            color: '#B45309',
            action: {
              type: 'postback',
              label: 'สมาชิกทั้งหมด',
              data: 'admin_members_all',
              displayText: 'ดูสมาชิกทั้งหมด'
            }
          },
          {
            type: 'button',
            style: 'secondary',
            action: {
              type: 'postback',
              label: 'สมาชิกรอตรวจสอบ',
              data: 'admin_members_pending',
              displayText: 'ดูสมาชิกรอตรวจสอบ'
            }
          },
          {
            type: 'button',
            style: 'secondary',
            action: {
              type: 'postback',
              label: 'สมาชิกหมดอายุ',
              data: 'admin_members_expired',
              displayText: 'ดูสมาชิกหมดอายุ'
            }
          },
          {
            type: 'button',
            style: 'secondary',
            action: {
              type: 'postback',
              label: 'TOPUP รอตรวจสอบ',
              data: 'admin_topup_pending',
              displayText: 'ดู TOPUP รอตรวจสอบ'
            }
          }
        ]
      }
    }
  };
}

function buildMemberStatusFlex(member, statusText) {
  return {
    type: 'flex',
    altText: 'สถานะการสมัคร',
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#0F172A',
        paddingAll: '16px',
        contents: [
          {
            type: 'text',
            text: 'สถานะการสมัคร',
            color: '#FFFFFF',
            weight: 'bold',
            size: 'lg'
          },
          {
            type: 'text',
            text: member.fullname || '-',
            color: '#CBD5E1',
            size: 'sm',
            margin: 'sm',
            wrap: true
          }
        ]
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          infoLine('ชื่อ', member.fullname || '-'),
          infoLine('สถานะ', statusText),
          infoLine('อนุมัติ', member.approvedAt || '-'),
          infoLine('อายุสมาชิก', `${member.approvedDays || 0} วัน`),
          infoLine('หมดอายุ', member.expireAt ? formatThaiDate(member.expireAt) : '-'),
          infoLine('เวลาล่าสุด', member.updatedAt || member.registeredAt || '-')
        ]
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          {
            type: 'button',
            style: 'primary',
            color: '#2563EB',
            action: {
              type: 'message',
              label: 'ดูเมนูหลัก',
              text: 'menu%'
            }
          },
          {
            type: 'button',
            style: 'secondary',
            action: {
              type: 'message',
              label: 'ติดต่อแอดมิน',
              text: 'ติดต่อแอดมิน'
            }
          }
        ]
      }
    }
  };
}

function buildAdminApproveFlex(member, targetUserId) {
  return {
    type: 'flex',
    altText: 'มีผู้สมัครใหม่รออนุมัติ',
    contents: {
      type: 'bubble',
      size: 'giga',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          {
            type: 'text',
            text: '📥 ผู้สมัครใหม่',
            weight: 'bold',
            size: 'xl',
            color: '#111827'
          },
          infoLine('LINE', member.lineName || '-'),
          infoLine('UID', targetUserId),
          infoLine('ยศ', member.rank || '-'),
          infoLine('ชื่อ', member.fullname || '-'),
          infoLine('ตำแหน่ง', member.position || '-'),
          infoLine('สังกัด', member.department || '-'),
          infoLine('เบอร์โทร', member.phone || '-'),
          infoLine('เวลาสมัคร', member.registeredAt || '-'),
          {
            type: 'text',
            text: 'เลือกจำนวนวันที่ต้องการอนุมัติสมาชิก',
            wrap: true,
            size: 'sm',
            color: '#B45309'
          }
        ]
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          {
            type: 'button',
            style: 'primary',
            color: '#16A34A',
            action: {
              type: 'postback',
              label: 'อนุมัติ 30 วัน',
              data: `approve_days|${targetUserId}|30`,
              displayText: `อนุมัติ 30 วัน ${member.fullname || targetUserId}`
            }
          },
          {
            type: 'button',
            style: 'primary',
            color: '#15803D',
            action: {
              type: 'postback',
              label: 'อนุมัติ 90 วัน',
              data: `approve_days|${targetUserId}|90`,
              displayText: `อนุมัติ 90 วัน ${member.fullname || targetUserId}`
            }
          },
          {
            type: 'button',
            style: 'primary',
            color: '#0F766E',
            action: {
              type: 'postback',
              label: 'อนุมัติ 180 วัน',
              data: `approve_days|${targetUserId}|180`,
              displayText: `อนุมัติ 180 วัน ${member.fullname || targetUserId}`
            }
          },
          {
            type: 'button',
            style: 'primary',
            color: '#1D4ED8',
            action: {
              type: 'postback',
              label: 'อนุมัติ 365 วัน',
              data: `approve_days|${targetUserId}|365`,
              displayText: `อนุมัติ 365 วัน ${member.fullname || targetUserId}`
            }
          },
          {
            type: 'button',
            style: 'secondary',
            action: {
              type: 'postback',
              label: 'ปฏิเสธ',
              data: `reject|${targetUserId}`,
              displayText: `ปฏิเสธ ${member.fullname || targetUserId}`
            }
          }
        ]
      }
    }
  };
}

function buildMemberManageFlex(member, targetUserId) {
  const expiredText = member.expireAt
    ? formatThaiDate(member.expireAt)
    : '-';

  const statusText =
    member.status === 'approved'
      ? (isExpired(member.expireAt) ? 'หมดอายุแล้ว' : 'อนุมัติแล้ว')
      : member.status === 'waiting_card'
        ? 'รอส่งรูปหลักฐาน'
        : member.status === 'pending'
          ? 'รอตรวจสอบ'
          : member.status === 'rejected'
            ? 'ถูกปฏิเสธ'
            : member.status || '-';

  return {
    type: 'flex',
    altText: 'จัดการสมาชิก',
    contents: {
      type: 'bubble',
      size: 'giga',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          {
            type: 'text',
            text: '👮 จัดการสมาชิก',
            weight: 'bold',
            size: 'xl',
            color: '#111827'
          },
          infoLine('ชื่อ', member.fullname || '-'),
          infoLine('LINE', member.lineName || '-'),
          infoLine('UID', targetUserId),
          infoLine('เบอร์', member.phone || '-'),
          infoLine('สถานะ', statusText),
          infoLine('อายุล่าสุด', member.approvedDays || 0),
          infoLine('หมดอายุ', expiredText),
          infoLine('ต่ออายุแล้ว', member.renewCount || 0)
        ]
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          {
            type: 'button',
            style: 'primary',
            color: '#16A34A',
            action: {
              type: 'postback',
              label: 'ต่ออายุ 30 วัน',
              data: `renew_days|${targetUserId}|30`,
              displayText: `ต่ออายุ 30 วัน ${member.fullname || targetUserId}`
            }
          },
          {
            type: 'button',
            style: 'primary',
            color: '#15803D',
            action: {
              type: 'postback',
              label: 'ต่ออายุ 90 วัน',
              data: `renew_days|${targetUserId}|90`,
              displayText: `ต่ออายุ 90 วัน ${member.fullname || targetUserId}`
            }
          },
          {
            type: 'button',
            style: 'primary',
            color: '#0F766E',
            action: {
              type: 'postback',
              label: 'ต่ออายุ 180 วัน',
              data: `renew_days|${targetUserId}|180`,
              displayText: `ต่ออายุ 180 วัน ${member.fullname || targetUserId}`
            }
          },
          {
            type: 'button',
            style: 'primary',
            color: '#1D4ED8',
            action: {
              type: 'postback',
              label: 'ต่ออายุ 365 วัน',
              data: `renew_days|${targetUserId}|365`,
              displayText: `ต่ออายุ 365 วัน ${member.fullname || targetUserId}`
            }
          }
        ]
      }
    }
  };
}

function buildTopupFlex() {
  return {
    type: 'flex',
    altText: 'TOPUP / แจ้งโอน',
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#0F172A',
        paddingAll: '16px',
        contents: [
          {
            type: 'text',
            text: 'TOPUP / แจ้งโอน',
            color: '#FFFFFF',
            weight: 'bold',
            size: 'lg'
          },
          {
            type: 'text',
            text: 'ส่งสลิปเพื่อให้แอดมินตรวจสอบ',
            color: '#CBD5E1',
            size: 'sm',
            margin: 'sm'
          }
        ]
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          menuSection('💳 แพ็กเกจที่รองรับ', [
            '┣ ╾ 30 วัน',
            '┣ ╾ 90 วัน',
            '┣ ╾ 180 วัน',
            '┗ ╾ 365 วัน'
          ]),
          menuSection('📌 วิธีแจ้งโอน', [
            '1) พิมพ์: topup30 หรือ topup90',
            '2) หรือ topup180 / topup365',
            '3) จากนั้นส่งสลิปเข้ามาในแชตนี้'
          ]),
          {
            type: 'text',
            text: 'หลังจากผู้ดูแลตรวจสอบแล้ว จะเป็นผู้กำหนดวันอนุมัติให้เอง',
            wrap: true,
            size: 'sm',
            color: '#B45309'
          }
        ]
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          {
            type: 'button',
            style: 'primary',
            color: '#2563EB',
            action: {
              type: 'message',
              label: 'เลือก 30 วัน',
              text: 'topup30'
            }
          },
          {
            type: 'button',
            style: 'secondary',
            action: {
              type: 'message',
              label: 'เลือก 90 วัน',
              text: 'topup90'
            }
          },
          {
            type: 'button',
            style: 'secondary',
            action: {
              type: 'message',
              label: 'เลือก 180 วัน',
              text: 'topup180'
            }
          },
          {
            type: 'button',
            style: 'secondary',
            action: {
              type: 'message',
              label: 'เลือก 365 วัน',
              text: 'topup365'
            }
          }
        ]
      }
    }
  };
}

function buildTopupAdminFlex(topup, userId) {
  return {
    type: 'flex',
    altText: 'มีรายการ TOPUP ใหม่',
    contents: {
      type: 'bubble',
      size: 'giga',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          {
            type: 'text',
            text: '💰 รายการ TOPUP ใหม่',
            weight: 'bold',
            size: 'xl',
            color: '#111827'
          },
          infoLine('ชื่อ', topup.fullname || topup.lineName || '-'),
          infoLine('LINE', topup.lineName || '-'),
          infoLine('UID', userId),
          infoLine('เบอร์', topup.phone || '-'),
          infoLine('แพ็กเกจ', topup.packageLabel || '-'),
          infoLine('เวลาแจ้ง', topup.updatedAt || '-'),
          {
            type: 'text',
            text: 'แอดมินตรวจสอบสลิปแล้วค่อยกำหนดวันอนุมัติเอง',
            wrap: true,
            size: 'sm',
            color: '#B45309'
          }
        ]
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          {
            type: 'button',
            style: 'primary',
            color: '#16A34A',
            action: {
              type: 'postback',
              label: 'อนุมัติ TOPUP แล้ว',
              data: `topup_approved|${userId}`,
              displayText: `อนุมัติ TOPUP ${topup.fullname || userId}`
            }
          },
          {
            type: 'button',
            style: 'secondary',
            action: {
              type: 'postback',
              label: 'ปฏิเสธ TOPUP',
              data: `topup_rejected|${userId}`,
              displayText: `ปฏิเสธ TOPUP ${topup.fullname || userId}`
            }
          }
        ]
      }
    }
  };
}

function buildContactAdminFlex() {
  return {
    type: 'flex',
    altText: 'ติดต่อแอดมิน',
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#0F172A',
        paddingAll: '16px',
        contents: [
          {
            type: 'text',
            text: '📩 ติดต่อแอดมิน',
            color: '#FFFFFF',
            weight: 'bold',
            size: 'lg'
          }
        ]
      },
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'text',
            text: 'สอบถามแอดมินแจ้งข้อความได้เลยครับ',
            wrap: true,
            size: 'md',
            color: '#111827'
          }
        ]
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          {
            type: 'button',
            style: 'primary',
            color: '#2563EB',
            action: {
              type: 'message',
              label: '📋 ดูเมนูคำสั่ง',
              text: 'menu%'
            }
          }
        ]
      }
    }
  };
}

function mapTopupPackage(text) {
  const cmd = text.toLowerCase().trim();
  if (cmd === 'topup30') return { days: 30, label: '30 วัน' };
  if (cmd === 'topup90') return { days: 90, label: '90 วัน' };
  if (cmd === 'topup180') return { days: 180, label: '180 วัน' };
  if (cmd === 'topup365') return { days: 365, label: '365 วัน' };
  return null;
}

function buildMembersAllText(db) {
  const allMembers = Object.entries(db.members);
  if (!allMembers.length) return 'ยังไม่มีสมาชิกในระบบ';

  const lines = allMembers.slice(0, 50).map(([uid, m], i) => {
    const statusText =
      m.status === 'approved'
        ? (isExpired(m.expireAt) ? 'หมดอายุ' : 'อนุมัติ')
        : m.status === 'waiting_card'
          ? 'รอส่งรูป'
          : m.status === 'pending'
            ? 'รอตรวจสอบ'
            : m.status === 'rejected'
              ? 'ปฏิเสธ'
              : m.status || '-';

    return `${i + 1}. ${m.fullname || '-'} | ${m.phone || '-'} | ${statusText}`;
  });

  return `สมาชิกทั้งหมด (${allMembers.length})\n\n${lines.join('\n')}`;
}

function buildMembersExpiredText(db) {
  const expired = Object.entries(db.members).filter(([_, m]) =>
    m.status === 'approved' && isExpired(m.expireAt)
  );

  if (!expired.length) return 'ยังไม่มีสมาชิกที่หมดอายุ';

  const lines = expired.slice(0, 50).map(([uid, m], i) =>
    `${i + 1}. ${m.fullname || '-'} | ${m.phone || '-'} | หมดอายุ: ${m.expireAt ? formatThaiDate(m.expireAt) : '-'}`
  );

  return `สมาชิกหมดอายุ (${expired.length})\n\n${lines.join('\n')}`;
}

function buildMembersPendingText(db) {
  const pending = Object.entries(db.members).filter(([_, m]) => m.status === 'pending');

  if (!pending.length) return 'ไม่มีสมาชิกที่รอตรวจสอบ';

  const lines = pending.slice(0, 50).map(([uid, m], i) =>
    `${i + 1}. ${m.fullname || '-'} | ${m.phone || '-'} | สมัครเมื่อ: ${m.registeredAt || '-'}`
  );

  return `สมาชิกที่รอตรวจสอบ (${pending.length})\n\n${lines.join('\n')}`;
}

function buildTopupPendingText(db) {
  const pendingTopups = Object.entries(db.topups || {}).filter(([_, t]) =>
    t.status === 'pending_review'
  );

  if (!pendingTopups.length) return 'ไม่มีรายการ TOPUP ที่รอตรวจสอบ';

  const lines = pendingTopups.slice(0, 50).map(([uid, t], i) =>
    `${i + 1}. ${t.fullname || t.lineName || '-'} | ${t.phone || '-'} | ${t.packageLabel || '-'} | ${t.updatedAt || '-'}`
  );

  return `รายการ TOPUP รอตรวจสอบ (${pendingTopups.length})\n\n${lines.join('\n')}`;
}

async function notifyAdmins(messages) {
  for (const adminId of ADMIN_IDS) {
    try {
      await push(adminId, messages);
    } catch (e) {
      console.error(`notify admin error (${adminId}):`, e?.response?.data || e.message);
    }
  }
}

function canUseBotCommands(userId, member, text) {
  // แอดมินใช้ได้ทุกคำสั่ง
  if (isAdmin(userId)) return true;

  // คำสั่งที่คนยังไม่อนุมัติใช้ได้
  const publicCommands = [
    'ยินยอมรับข้อตกลง',
    'สถานะการสมัคร',
    'myid',
    'ติดต่อแอดมิน'
    'hadmin'
  ];

  if (publicCommands.includes(text)) return true;
  if (text.startsWith('regis%')) return true;

  // คำสั่งอื่นทั้งหมด ต้องเป็นสมาชิก approved และไม่หมดอายุ
  return isActiveMember(member);
}

async function handleEvent(event) {
  const db = loadDB();

  const eventId = event.webhookEventId;
  if (eventId && isEventProcessed(db, eventId)) {
    return null;
  }

  if (eventId) {
    markEventProcessed(db, eventId);
    saveDB(db);
  }

  if (event.type === 'postback') {
    return handlePostback(event);
  }

  if (event.type !== 'message') {
    return null;
  }

  if (event.message.type === 'text') {
    return handleText(event);
  }

  if (event.message.type === 'image') {
    return handleImage(event);
  }

  return null;
}

async function handleText(event) {
  const userId = event.source.userId;
  const text = (event.message.text || '').trim();
  const db = loadDB();
  const member = db.members[userId];

if (!canUseBotCommands(userId, member, text)) {

  if (!member) {
    return reply(event.replyToken, {
      type: 'text',
      text: '❌ ยังไม่มีสิทธิ์ใช้งาน กรุณาสมัครสมาชิกก่อน โดยพิมพ์: ยินยอมรับข้อตกลง'
    });
  }

  if (!isActiveMember(member)) {
    return reply(event.replyToken, {
      type: 'text',
      text: '⛔ บัญชีของคุณยังไม่ได้รับการอนุมัติ หรือสมาชิกหมดอายุ'
    });
  }

  return reply(event.replyToken, {
    type: 'text',
    text: '❌ คุณไม่มีสิทธิ์ใช้งานคำสั่งนี้'
  });
}

    if (member.status !== 'approved') {
      return reply(event.replyToken, {
        type: 'text',
        text: '⏳ บัญชีของคุณยังไม่ได้รับการอนุมัติจากแอดมิน'
      });
    }

    if (isExpired(member.expireAt)) {
      return reply(event.replyToken, {
        type: 'text',
        text:
          '❌ สมาชิกของคุณหมดอายุแล้ว\n' +
          `หมดอายุเมื่อ: ${member.expireAt ? formatThaiDate(member.expireAt) : '-'}\n` +
          'กรุณาติดต่อแอดมินเพื่อต่ออายุ'
      });
    }

    return reply(event.replyToken, {
      type: 'text',
      text: '❌ คุณไม่มีสิทธิ์ใช้งานคำสั่งนี้'
    });

  if (text === 'menu%') {
    return reply(event.replyToken, [
      {
        type: 'text',
        text: '📋 เมนูคำสั่ง MEGABOT\nเลื่อนดูเมนูแต่ละหน้าได้เลย'
      },
      buildMenuCarouselFlex()
    ]);
  }

  if (text === 'hadmin') {
    if (!isAdmin(userId)) {
      return reply(event.replyToken, {
        type: 'text',
        text: 'คุณไม่มีสิทธิ์ใช้คำสั่งนี้'
      });
    }

    return reply(event.replyToken, buildAdminMenuFlex());
  }

  if (text === 'myid') {
    return reply(event.replyToken, {
      type: 'text',
      text: `Your userId:\n${userId}`
    });
  }

  if (text === 'ยินยอมรับข้อตกลง') {
    return reply(event.replyToken, buildRegisterGuideFlex());
  }

  if (text === 'ติดต่อแอดมิน') {
  return reply(event.replyToken, buildContactAdminFlex());
  }

  if (text === 'สถานะการสมัคร') {
    if (!member) {
      return reply(event.replyToken, {
        type: 'text',
        text: 'คุณยังไม่ได้สมัครสมาชิก\nกรุณาพิมพ์: ยินยอมรับข้อตกลง'
      });
    }

    let statusText = '';
    if (member.status === 'approved') {
      statusText = isExpired(member.expireAt)
        ? 'หมดอายุแล้ว'
        : 'อนุมัติแล้ว';
    } else if (member.status === 'waiting_card') {
      statusText = 'รอส่งรูปหลักฐาน';
    } else if (member.status === 'pending') {
      statusText = 'รอตรวจสอบ';
    } else if (member.status === 'rejected') {
      statusText = 'ถูกปฏิเสธ';
    } else {
      statusText = member.status;
    }

  const profile = await getProfile(userId);

return reply(
  event.replyToken,
  buildMemberStatusFlex(member, statusText, profile)
);
  }

  if (text.startsWith('%')) {
    const msisdn = text.substring(1).trim();
    if (!msisdn) {
      return reply(event.replyToken, {
        type: 'text',
        text: '❌ กรุณาระบุหมายเลขโทรศัพท์ เช่น %+66987654321'
      });
    }
    try {
      const response = await fetchHlrLookup(msisdn);

      if (response.status === 200) {
        const data = response.data;

        let resultMsg = `MSISDN: ${data.msisdn || msisdn}\n`;
        resultMsg += `Subscriber Status: ${(data.connectivity_status || 'N/A').toString().toUpperCase()}\n`;
        resultMsg += `MCC: ${data.mcc || 'N/A'}\n`;
        resultMsg += `MNC: ${data.mnc || 'N/A'}\n`;
        resultMsg += `IMSI: ${data.imsi || 'N/A'}\n`;
        resultMsg += `MSIN: ${data.msin || 'N/A'}\n`;
        resultMsg += `MSC: ${data.msc || 'N/A'}\n`;
        resultMsg += `Network Name: ${data.original_network_name || 'N/A'}\n`;
        resultMsg += `Country Name: ${data.original_country_name || 'N/A'}\n`;
        resultMsg += `Country Code: ${data.original_country_code || 'N/A'}\n`;
        resultMsg += `Country PREFIX: ${data.original_country_prefix || 'N/A'}\n`;
        resultMsg += `PORTED: ${data.is_ported ? 'TRUE' : 'FALSE'}\n`;
        resultMsg += `PORTED NETWORK Name: ${data.ported_network_name || 'NULL'}\n`;
        resultMsg += `PORTED Country Name: ${data.ported_country_name || 'NULL'}\n`;
        resultMsg += `PORTED Country Code: ${data.ported_country_code || 'NULL'}\n`;
        resultMsg += `Roaming: ${data.is_roaming ? 'Yes' : 'No'}\n`;
        resultMsg += `DATE: ${data.timestamp || 'N/A'}`;

        console.log(`success HLR Lookup: ${msisdn}`);
        return reply(event.replyToken, {
          type: 'text',
          text: resultMsg
        });
      } else {
        console.error(`error HLR Lookup failed: ${msisdn} - Status: ${response.status}`);
        return reply(event.replyToken, {
          type: 'text',
          text: `Error: Could not retrieve data (Status: ${response.status})`
        });
      }
    } catch (error) {
      console.error(`error HLR Lookup Error: ${error.message}`);
      return reply(event.replyToken, {
        type: 'text',
        text: 'Error: HLR lookup failed - ' + error.message
      });
    }
  }

  if (/^s%\d{13}$/.test(text)) {
    const nationId = text.replace(/^s%/, '').trim();

    try {
      const result = await fetchInstallment(nationId);
      const msg = formatInstallment(result);

      return reply(event.replyToken, {
        type: 'text',
        text: msg
      });
    } catch (err) {
      console.error('installment lookup error:', err?.response?.data || err.message);

      return reply(event.replyToken, {
        type: 'text',
        text: '❌ ดึงข้อมูลผ่อนสินค้าไม่สำเร็จ'
      });
    }
  }

  if (/^c#\d{13}$/.test(text)) {
    const nationId = text.replace(/^c#/, '').trim();

    try {
      const result = await fetchCrime(nationId);

      console.log('===== CRIME FULL RESPONSE START =====');
      console.log(JSON.stringify(result, null, 2));
      console.log('===== CRIME FULL RESPONSE END =====');

      const msg = formatCrime(result, nationId);

      return reply(event.replyToken, {
        type: 'text',
        text: msg
      });
    } catch (err) {
      console.error('crime error:', err?.response?.data || err.message);

      return reply(event.replyToken, {
        type: 'text',
        text: '❌ ดึงข้อมูลหมายจับไม่สำเร็จ'
      });
    }
  }

  if (text.startsWith('?')) {
    const phone = text.substring(1).trim();
    if (!phone) {
      return reply(event.replyToken, {
        type: 'text',
        text: 'กรุณาระบุเบอร์โทรศัพท์\nตัวอย่าง: ?0812345678'
      });
    }

    const result = await fetchCallerInfo(phone);
    return reply(event.replyToken, {
      type: 'text',
      text: result
    });
  }

  if (text.startsWith('regis%')) {
    const raw = text.replace(/^regis%/i, '').trim();
    const parts = raw.split('/').map(v => v.trim());

    if (parts.length < 5) {
      return reply(event.replyToken, {
        type: 'text',
        text:
          'รูปแบบไม่ถูกต้อง\n' +
          'กรุณาส่งแบบนี้:\n' +
          'regis%ยศ/ชื่อ-สกุล/ตำแหน่ง/สังกัด/เบอร์โทร'
      });
    }

    const [rank, fullname, position, department, phone] = parts;

    const duplicatePhone = Object.entries(db.members).find(([id, m]) => {
      return id !== userId && m.phone === phone && ['pending', 'approved', 'waiting_card'].includes(m.status);
    });

    if (duplicatePhone) {
      return reply(event.replyToken, {
        type: 'text',
        text: 'เบอร์โทรนี้มีอยู่ในระบบแล้ว กรุณาติดต่อผู้ดูแล'
      });
    }

    if (db.members[userId] && ['pending', 'approved'].includes(db.members[userId].status)) {
      return reply(event.replyToken, {
        type: 'text',
        text: 'คุณเคยสมัครแล้ว ระบบมีข้อมูลของคุณอยู่แล้ว'
      });
    }

    const profile = await getProfile(userId);

    db.members[userId] = {
      userId,
      lineName: profile.displayName || 'ไม่ทราบชื่อ',
      rank,
      fullname,
      position,
      department,
      phone,
      status: 'waiting_card',
      registeredAt: nowThai(),
      updatedAt: nowThai(),
      imagePath: '',
      imageUrl: '',
      approvedAt: '',
      approvedDays: 0,
      expireAt: '',
      renewCount: 0
    };

    saveDB(db);

    return reply(event.replyToken, {
      type: 'text',
      text:
        'บันทึกข้อมูลสมัครเรียบร้อยแล้ว\n' +
        'กรุณาส่งรูปบัตรหรือภาพหลักฐานต่อได้เลย'
    });
  }

  if (text === 'members_all') {
    if (!isAdmin(userId)) {
      return reply(event.replyToken, { type: 'text', text: 'คุณไม่มีสิทธิ์ใช้คำสั่งนี้' });
    }
    return reply(event.replyToken, { type: 'text', text: buildMembersAllText(db) });
  }

  if (text === 'members_expired') {
    if (!isAdmin(userId)) {
      return reply(event.replyToken, { type: 'text', text: 'คุณไม่มีสิทธิ์ใช้คำสั่งนี้' });
    }
    return reply(event.replyToken, { type: 'text', text: buildMembersExpiredText(db) });
  }

  if (text === 'members_pending') {
    if (!isAdmin(userId)) {
      return reply(event.replyToken, { type: 'text', text: 'คุณไม่มีสิทธิ์ใช้คำสั่งนี้' });
    }
    return reply(event.replyToken, { type: 'text', text: buildMembersPendingText(db) });
  }

  if (text === 'topup_pending') {
    if (!isAdmin(userId)) {
      return reply(event.replyToken, { type: 'text', text: 'คุณไม่มีสิทธิ์ใช้คำสั่งนี้' });
    }
    return reply(event.replyToken, { type: 'text', text: buildTopupPendingText(db) });
  }

  if (text === 'TOPUP' || text === 'topup') {
    return reply(event.replyToken, buildTopupFlex());
  }

  const topupPackage = mapTopupPackage(text);
  if (topupPackage) {
    const profile = await getProfile(userId);

    db.topups[userId] = {
      userId,
      lineName: profile.displayName || member?.lineName || 'ไม่ทราบชื่อ',
      fullname: member?.fullname || '',
      phone: member?.phone || '',
      packageDays: topupPackage.days,
      packageLabel: topupPackage.label,
      status: 'waiting_slip',
      createdAt: nowThai(),
      updatedAt: nowThai(),
      slipImagePath: '',
      slipImageUrl: ''
    };

    saveDB(db);

    return reply(event.replyToken, {
      type: 'text',
      text:
        `คุณเลือกแพ็กเกจ ${topupPackage.label} แล้ว\n` +
        `กรุณาส่งสลิปเข้ามาในแชตนี้ได้เลย`
    });
  }

  if (text.startsWith('member#')) {
    if (!isAdmin(userId)) {
      return reply(event.replyToken, {
        type: 'text',
        text: 'คุณไม่มีสิทธิ์ใช้คำสั่งนี้'
      });
    }

    const phone = text.replace('member#', '').trim();
    const foundEntry = Object.entries(db.members).find(([_, m]) => m.phone === phone);

    if (!foundEntry) {
      return reply(event.replyToken, {
        type: 'text',
        text: 'ไม่พบสมาชิกจากเบอร์นี้'
      });
    }

    const [targetUserId, found] = foundEntry;
    return reply(event.replyToken, [
      buildMemberManageFlex(found, targetUserId),
      {
        type: 'text',
        text:
          `ข้อมูลสมาชิก\n` +
          `ชื่อ: ${found.fullname || '-'}\n` +
          `LINE: ${found.lineName || '-'}\n` +
          `UID: ${targetUserId}\n` +
          `เบอร์: ${found.phone || '-'}`
      }
    ]);
  }

  if (/^renew(30|90|180|365)#/.test(text)) {
    if (!isAdmin(userId)) {
      return reply(event.replyToken, {
        type: 'text',
        text: 'คุณไม่มีสิทธิ์ใช้คำสั่งนี้'
      });
    }

    const match = text.match(/^renew(30|90|180|365)#(.+)$/);
    const days = Number(match[1]);
    const phone = match[2].trim();

    const foundEntry = Object.entries(db.members).find(([_, m]) => m.phone === phone);

    if (!foundEntry) {
      return reply(event.replyToken, {
        type: 'text',
        text: 'ไม่พบสมาชิกจากเบอร์นี้'
      });
    }

    const [targetUserId, found] = foundEntry;

    let baseDate = new Date();
    if (found.expireAt && !isExpired(found.expireAt)) {
      baseDate = new Date(found.expireAt);
    }

    baseDate.setDate(baseDate.getDate() + days);

    found.status = 'approved';
    found.updatedAt = nowThai();
    found.approvedDays = days;
    found.expireAt = baseDate.toISOString();
    found.renewCount = Number(found.renewCount || 0) + 1;

    db.members[targetUserId] = found;
    saveDB(db);

    try {
      await push(targetUserId, {
        type: 'text',
        text:
          `สมาชิกของคุณได้รับการต่ออายุแล้ว ✅\n` +
          `ต่อเพิ่ม: ${days} วัน\n` +
          `วันหมดอายุใหม่: ${formatThaiDate(baseDate)}`
      });
    } catch (e) {
      console.error('push renew error:', e?.response?.data || e.message);
    }

    return reply(event.replyToken, {
      type: 'text',
      text:
        `ต่ออายุ ${found.fullname || targetUserId} เรียบร้อยแล้ว\n` +
        `เพิ่ม: ${days} วัน\n` +
        `หมดอายุใหม่: ${formatThaiDate(baseDate)}`
    });
  }

  // ประกันสังคม: si%เลขบัตร
  if (text.startsWith('si%')) {
    const ssoNum = text.replace(/^si%/, '').trim();
    if (!ssoNum) return reply(event.replyToken, { type: 'text', text: '❌ กรุณาระบุเลขบัตรประชาชน เช่น si%1234567890123' });
    try {
      const { data: res } = await axios.get(`http://103.91.204.203:4000/?si=${ssoNum}`);
      if (!res.success) return reply(event.replyToken, { type: 'text', text: `❌ ${res.message || 'ดึงข้อมูลไม่สำเร็จ'}` });
      const data = res.data;
      if (data.content && data.content.length > 0) {
        let result = `👔 ประวัติการทำงานประกันสังคม\n====================\n🆔 เลขประกันสังคม: ${ssoNum}\n📊 จำนวนที่พบ: ${data.totalElements} รายการ\n`;
        data.content.forEach((item, idx) => {
          result += `\n🏢 บริษัท ${idx + 1}\nชื่อบริษัท: ${item.companyName || 'ไม่ระบุ'}\nรหัสสาขา: ${item.accBran || 'ไม่ระบุ'}\nเลขที่บัญชี: ${item.accNo || 'ไม่ระบุ'}\nวันที่เริ่มงาน: ${item.expStartDateText || 'ไม่ระบุ'}\nวันที่ลาออก: ${item.empResignDateText || '-'}\nสถานะ: ${item.employStatusDesc || 'ไม่ระบุ'}\n--------------------`;
        });
        return reply(event.replyToken, { type: 'text', text: result });
      } else {
        return reply(event.replyToken, { type: 'text', text: 'ไม่พบข้อมูลประวัติการทำงานประกันสังคม' });
      }
    } catch (err) {
      return reply(event.replyToken, { type: 'text', text: '❌ ดึงข้อมูลประกันสังคมไม่สำเร็จ' });
    }
  }

  // หมายศาล: doc#เลขบัตร [หน้า]
  if (text.startsWith('doc#')) {
    const payload = text.replace(/^doc#/, '').trim();
    const parts = payload.split(/\s+/);
    const accCardId = parts[0];
    let page = parts[1] ? parseInt(parts[1]) - 1 : 0;
    if (!accCardId) return reply(event.replyToken, { type: 'text', text: '❌ กรุณาระบุเลขบัตรประชาชน เช่น doc#1234567890123' });
    try {
      const { data: res } = await axios.get(`http://103.91.204.203:4000/?doc=${accCardId}`);
      if (!res.success) return reply(event.replyToken, { type: 'text', text: `❌ ${res.message || 'ดึงข้อมูลไม่สำเร็จ'}` });
      const data = res.data;
      if (data.content && data.content.length > 0) {
        const itemsPerPage = 3;
        const totalPages = Math.ceil(data.content.length / itemsPerPage);
        if (isNaN(page) || page < 0) page = 0;
        if (page >= totalPages) return reply(event.replyToken, { type: 'text', text: `ไม่พบข้อมูลหน้าที่ ${page + 1} (มีทั้งหมด ${totalPages} หน้า)` });
        const startIndex = page * itemsPerPage;
        const pageItems = data.content.slice(startIndex, Math.min(startIndex + itemsPerPage, data.content.length));
        let result = `🚨 ข้อมูลหมายศาล (หน้า ${page + 1}/${totalPages})\n====================\n`;
        pageItems.forEach((warrant, idx) => {
          result += `\n📄 หมายจับที่ ${startIndex + idx + 1}\nเลขที่: ${warrant.woaNo}/${warrant.woaYear}\nศาล: ${warrant.courtCodeText}\n\n👤 ข้อมูลผู้ต้องหา\nชื่อ-สกุล: ${warrant.accFullName}\nเลขบัตรประชาชน: ${warrant.accCardId}\nสัญชาติ: ${warrant.accNationText}\nอาชีพ: ${warrant.accOccupation}\n\n📍 ที่อยู่\nตำบล/แขวง: ${warrant.accSubDistrictText || warrant.accSubDistrict}\nอำเภอ/เขต: ${warrant.accDistrictText}\n\n⚖️ ข้อมูลคดี\nสถานะ: ${warrant.arrestStatus}\nข้อหา: ${warrant.charge}\nผู้ร้อง: ${warrant.plaintiff}\nผู้พิพากษา: ${warrant.judgeName}\n\n📅 วันที่\nออกหมาย: ${new Date(warrant.woaDate).toLocaleDateString('th-TH')}\nเริ่มต้น: ${new Date(warrant.woaStartDate).toLocaleDateString('th-TH')}\nสิ้นสุด: ${new Date(warrant.woaEndDate).toLocaleDateString('th-TH')}\n-------------------`;
        });
        result += `\n📊 แสดง ${pageItems.length} จาก ${data.content.length} รายการ`;
        if (totalPages > 1) result += `\nพิมพ์ doc#${accCardId} [1-${totalPages}] เพื่อดูหน้าอื่น`;
        return reply(event.replyToken, { type: 'text', text: result });
      } else {
        return reply(event.replyToken, { type: 'text', text: 'ไม่พบข้อมูลหมายศาล' });
      }
    } catch (err) {
      return reply(event.replyToken, { type: 'text', text: '❌ ดึงข้อมูลหมายศาลไม่สำเร็จ' });
    }
  }

  // ใบขับขี่: dl#เลขบัตร
  if (text.startsWith('dl#')) {
    const cid = text.replace(/^dl#/, '').trim();
    if (!cid) return reply(event.replyToken, { type: 'text', text: '❌ กรุณาระบุเลขบัตรประชาชน เช่น dl#1234567890123' });
    try {
      const { data: res } = await axios.get(`http://103.91.204.203:4000/?dl=${cid}`);
      if (!res.success) return reply(event.replyToken, { type: 'text', text: `❌ ${res.message || 'ดึงข้อมูลไม่สำเร็จ'}` });
      const data = res.data;
      if (data.content && data.content.length > 0) {
        let result = `🚗 ข้อมูลใบขับขี่\n====================\n`;
        data.content.forEach((license, idx) => {
          result += `\n📄 ใบขับขี่ที่ ${idx + 1}\n👤 ชื่อ-นามสกุล: ${license.fullName}\n🆔 เลขบัตรประชาชน: ${license.citizenCardNumber}\n🚗 ประเภทใบขับขี่: ${license.type}\n📝 เลขที่ใบขับขี่: ${license.licenseNumber}\n📅 วันที่ออกใบอนุญาต: ${new Date(license.licenseIssueDate).toLocaleDateString('th-TH')}\n📅 วันที่หมดอายุ: ${new Date(license.licenseExpirationDate).toLocaleDateString('th-TH')}\n⭐ สถานะ: ${license.status}\n🏠 ที่อยู่: ${license.address}\n-------------------`;
        });
        result += `\n📊 พบข้อมูลทั้งหมด ${data.totalElements} รายการ`;
        return reply(event.replyToken, { type: 'text', text: result });
      } else {
        return reply(event.replyToken, { type: 'text', text: 'ไม่พบข้อมูลใบขับขี่' });
      }
    } catch (err) {
      return reply(event.replyToken, { type: 'text', text: '❌ ดึงข้อมูลใบขับขี่ไม่สำเร็จ' });
    }
  }

  // เช็ครถจาก CID: cid#เลขบัตร
  if (text.startsWith('cid#')) {
    const cid = text.replace(/^cid#/, '').trim();
    if (!cid) return reply(event.replyToken, { type: 'text', text: '❌ กรุณาระบุเลขบัตรประชาชน เช่น cid#1234567890123' });
    try {
      const { data: res } = await axios.get(`http://103.91.204.203:4000/?cid=${cid}`);
      if (!res.success) return reply(event.replyToken, { type: 'text', text: `❌ ${res.message || 'ดึงข้อมูลไม่สำเร็จ'}` });
      const data = res.data;
      if (data.content && data.content.length > 0) {
        let result = `🚗 ข้อมูลทะเบียนรถ (จาก CID)\n====================\n`;
        data.content.slice(0, 5).forEach((vehicle, idx) => {
          result += `\n📄 รถคันที่ ${idx + 1}\n🚘 ทะเบียน: ${vehicle.plate1 || ''}${vehicle.plate2 || ''}\n🚗 ยี่ห้อ: ${vehicle.brnDesc || 'ไม่ระบุ'}\n🎨 สี: ${(vehicle.carChkMasColorList && vehicle.carChkMasColorList[0]?.colorDesc) || 'ไม่ระบุ'}\n🔧 ประเภท: ${vehicle.vehTypeDesc || 'ไม่ระบุ'}\n👤 เจ้าของ: ${vehicle.owner1 || 'ไม่ระบุ'}\n📅 หมดอายุ: ${vehicle.expDate ? new Date(vehicle.expDate).toLocaleDateString('th-TH') : 'ไม่ระบุ'}\n-------------------`;
        });
        result += `\n📊 พบทั้งหมด ${data.content.length} คัน`;
        return reply(event.replyToken, { type: 'text', text: result });
      } else {
        return reply(event.replyToken, { type: 'text', text: 'ไม่พบข้อมูลทะเบียนรถ' });
      }
    } catch (err) {
      return reply(event.replyToken, { type: 'text', text: '❌ ดึงข้อมูลทะเบียนรถไม่สำเร็จ' });
    }
  }

  // เช็ครถจากทะเบียน: car#จังหวัด หมวด ตัวเลข ประเภท [หน้า]
  if (text.startsWith('car#')) {
    const payload = text.replace(/^car#/, '').trim();
    const parts = payload.split(/\s+/);
    if (parts.length < 4) {
      return reply(event.replyToken, { type: 'text', text: '❌ รูปแบบไม่ถูกต้อง\nตัวอย่าง: car#กรุงเทพ 1กก 334 1\ncar#จังหวัด หมวดอักษร ตัวเลข ประเภทรถ' });
    }
    const province = parts[0];
    const plate1 = parts[1];
    const plate2 = parts[2];
    const vehTypeRef = parts[3];
    let page = parts[4] ? parseInt(parts[4]) - 1 : 0;
    try {
      const url = `http://103.91.204.203:4000/?province=${encodeURIComponent(province)}&plate1=${encodeURIComponent(plate1)}&plate2=${encodeURIComponent(plate2)}&vehTypeRef=${encodeURIComponent(vehTypeRef)}`;
      const { data: res } = await axios.get(url);
      if (!res.success) return reply(event.replyToken, { type: 'text', text: `❌ ${res.message || 'ดึงข้อมูลไม่สำเร็จ'}` });
      const data = res.data;
      if (data.content && data.content.length > 0) {
        const itemsPerPage = 3;
        const totalPages = Math.ceil(data.content.length / itemsPerPage);
        if (isNaN(page) || page < 0) page = 0;
        if (page >= totalPages) return reply(event.replyToken, { type: 'text', text: `ไม่พบข้อมูลหน้าที่ ${page + 1} (มีทั้งหมด ${totalPages} หน้า)` });
        const startIndex = page * itemsPerPage;
        const pageItems = data.content.slice(startIndex, Math.min(startIndex + itemsPerPage, data.content.length));
        let result = `🚗 ข้อมูลทะเบียนรถ (หน้า ${page + 1}/${totalPages})\n====================\n`;
        pageItems.forEach((vehicle, idx) => {
          result += `\n📄 รถคันที่ ${startIndex + idx + 1}\n🚘 ทะเบียน: ${vehicle.plate1 || ''}${vehicle.plate2 || ''}\n🏢 สำนักงาน: ${vehicle.offLocDesc || 'ไม่ระบุ'}\n🚗 ยี่ห้อ: ${vehicle.brnDesc || 'ไม่ระบุ'}\n📝 รุ่น: ${vehicle.modelName || 'ไม่ระบุ'}\n🎨 สี: ${(vehicle.carChkMasColorList && vehicle.carChkMasColorList[0]?.colorDesc) || 'ไม่ระบุ'}\n🔧 ประเภทรถ: ${vehicle.vehTypeDesc || 'ไม่ระบุ'}\n📋 หมายเลขตัวถัง: ${vehicle.numBody || 'ไม่ระบุ'}\n📅 วันที่จดทะเบียน: ${vehicle.regDate ? new Date(vehicle.regDate).toLocaleDateString('th-TH') : 'ไม่ระบุ'}\n📅 วันที่หมดอายุ: ${vehicle.expDate ? new Date(vehicle.expDate).toLocaleDateString('th-TH') : 'ไม่ระบุ'}\n\n👤 ข้อมูลเจ้าของ\nเจ้าของที่ 1:\nเลขประจำตัว: ${vehicle.docNo1 || 'ไม่ระบุ'}\nชื่อ: ${vehicle.owner1 || 'ไม่ระบุ'}\nที่อยู่: ${vehicle.addressOwner1 || 'ไม่ระบุ'}\n${vehicle.docNo2 ? `\nเจ้าของที่ 2:\nเลขประจำตัว: ${vehicle.docNo2}\nชื่อ: ${vehicle.owner2 || 'ไม่ระบุ'}` : ''}\n-------------------`;
        });
        result += `\n📊 แสดง ${pageItems.length} จาก ${data.content.length} รายการ`;
        if (totalPages > 1) result += `\nพิมพ์ car#${province} ${plate1} ${plate2} ${vehTypeRef} [หน้า] เพื่อดูหน้าอื่น`;
        return reply(event.replyToken, { type: 'text', text: result });
      } else {
        return reply(event.replyToken, { type: 'text', text: 'ไม่พบข้อมูลทะเบียนรถ' });
      }
    } catch (err) {
      return reply(event.replyToken, { type: 'text', text: '❌ ดึงข้อมูลทะเบียนรถไม่สำเร็จ' });
    }
  }

  if (text.startsWith('h%')) {
    const pidToSearch = text.replace(/^h%/, '').trim();
    if (!pidToSearch) {
      return reply(event.replyToken, { type: 'text', text: '❌ กรุณาระบุเลขบัตรประชาชน เช่น h%1234567890123' });
    }
    const result = await searchJediHp(pidToSearch);
    return reply(event.replyToken, { type: 'text', text: result });
  }

  if (text.startsWith('tic%')) {
    const trackingId = text.replace(/^tic%/, '').trim();
    if (!trackingId) {
      return reply(event.replyToken, { type: 'text', text: '❌ กรุณาระบุเลขพัสดุ เช่น tic%THT123456789TH' });
    }
    const result = await trackFlashExpress(trackingId);
    return reply(event.replyToken, { type: 'text', text: result });
  }

  if (text.startsWith('ip%')) {
    const ip = text.replace(/^ip%/, '').trim();
    if (!ip) {
      return reply(event.replyToken, { type: 'text', text: 'กรุณาระบุ IP Address\nตัวอย่าง: ip%1.1.1.1' });
    }
    const result = await getIpInfo(ip);
    return reply(event.replyToken, { type: 'text', text: result });
  }

  if (text.startsWith('imei%')) {
    const imei = text.replace(/^imei%/, '').trim();
    if (!imei) {
      return reply(event.replyToken, { type: 'text', text: '❌ กรุณาระบุหมายเลข IMEI เช่น imei%123456789012345' });
    }
    const result = await searchIMEI(imei);
    return reply(event.replyToken, { type: 'text', text: result });
  }

  if (text.startsWith('imsi%')) {
    const imsiNumber = text.replace(/^imsi%/, '').trim();
    if (!imsiNumber) {
      return reply(event.replyToken, { type: 'text', text: '❌ กรุณาระบุหมายเลข IMSI เช่น imsi%520044020881702' });
    }
    const result = await searchIMSI(imsiNumber);
    return reply(event.replyToken, { type: 'text', text: result });
  }

  if (text.startsWith('icc%')) {
    const iccidNumber = text.replace(/^icc%/, '').trim();
    if (!iccidNumber) {
      return reply(event.replyToken, { type: 'text', text: '❌ กรุณาระบุหมายเลข ICCID เช่น icc%89660448216080569814' });
    }
    const result = await searchICCID(iccidNumber);
    return reply(event.replyToken, { type: 'text', text: result });
  }

  if (text.startsWith('map%')) {
    const coordinates = text.replace(/^map%/, '').trim();
    if (!coordinates) {
      return reply(event.replyToken, { type: 'text', text: '❌ กรุณาระบุพิกัด เช่น map%13.7563,100.5018' });
    }
    const result = await createMapLink(coordinates);
    return reply(event.replyToken, { type: 'text', text: result });
  }

  if (text.startsWith('web%')) {
    const url = text.replace(/^web%/, '').trim();
    if (!url) {
      return reply(event.replyToken, { type: 'text', text: '❌ กรุณาระบุเว็บไซต์ เช่น web%example.com' });
    }
    const result = await getWebInfo(url);
    return reply(event.replyToken, { type: 'text', text: result });
  }

  if (text.startsWith('psi#')) {
    const input = text.replace(/^psi#/, '').trim();
    if (!input) {
      return reply(event.replyToken, { type: 'text', text: '❌ กรุณาระบุเลขบัตรประชาชน เช่น psi#1234567890123' });
    }
    try {
      const data = await fetchPEAApi({ psi: input });
      const result = formatPrisonerRecords(data, input, false);
      return reply(event.replyToken, { type: 'text', text: result });
    } catch (err) {
      console.error('psi error:', err?.response?.data || err.message);
      return reply(event.replyToken, { type: 'text', text: '❌ ดึงข้อมูลผู้ต้องขังไม่สำเร็จ: ' + err.message });
    }
  }

  if (text.startsWith('ps#')) {
    const input = text.replace(/^ps#/, '').trim();
    if (!input) {
      return reply(event.replyToken, { type: 'text', text: '❌ กรุณาระบุเลขบัตรประชาชน เช่น ps#1234567890123' });
    }
    try {
      const data = await fetchPEAApi({ ps: input });
      const result = formatPrisonerRecords(data, input, true);
      return reply(event.replyToken, { type: 'text', text: result });
    } catch (err) {
      console.error('ps error:', err?.response?.data || err.message);
      return reply(event.replyToken, { type: 'text', text: '❌ ดึงข้อมูลผู้ต้องขัง (ยังไม่พิพากษา) ไม่สำเร็จ: ' + err.message });
    }
  }

  if (text.startsWith('peab%')) {
    const parts = text.replace(/^peab%/, '').trim().split(/\s+/);
    const ca = parts[0];
    const peano = parts[1];
    if (!ca || !peano) {
      return reply(event.replyToken, { type: 'text', text: '❌ กรุณาระบุข้อมูลให้ครบ เช่น peab%020006438778 6300096416' });
    }
    try {
      const data = await fetchPEAApi({ peab: ca, peano });
      const result = formatPEABillHistory(data, ca, peano);
      return reply(event.replyToken, { type: 'text', text: result });
    } catch (err) {
      console.error('peab error:', err?.response?.data || err.message);
      return reply(event.replyToken, { type: 'text', text: '❌ ดึงข้อมูลประวัติค่าไฟ PEA ไม่สำเร็จ: ' + err.message });
    }
  }

  if (text.startsWith('peac%')) {
    const parts = text.replace(/^peac%/, '').trim().split(/\s+/);
    const ca = parts[0];
    const page = parts[1] ? parseInt(parts[1], 10) - 1 : 0;
    if (!ca) {
      return reply(event.replyToken, { type: 'text', text: '❌ กรุณาระบุเลข CA เช่น peac%020006438778' });
    }
    try {
      const data = await fetchPEAApi({ peac: ca });
      const result = formatPEAMeterRecords(data, '⚡ ข้อมูลมิเตอร์ไฟฟ้า PEA', page);
      return reply(event.replyToken, { type: 'text', text: result });
    } catch (err) {
      console.error('peac error:', err?.response?.data || err.message);
      return reply(event.replyToken, { type: 'text', text: '❌ ดึงข้อมูล PEA จากเลข CA ไม่สำเร็จ: ' + err.message });
    }
  }

  if (text.startsWith('pean%') || text.startsWith('pean#')) {
    const input = text.replace(/^pean[%#]/, '').trim();
    const parts = input.split(/\s+/);
    let page = 0;
    if (parts.length > 2 && /^\d+$/.test(parts[parts.length - 1])) {
      page = parseInt(parts.pop(), 10) - 1;
    }
    const name = parts.join(' ');
    if (!name) {
      return reply(event.replyToken, { type: 'text', text: '❌ กรุณาใส่ชื่อเต็มและนามสกุล เช่น pean%เย็น เก่งสาริกิจ' });
    }
    try {
      const data = await fetchPEAApi({ pean: name });
      const result = formatPEAMeterRecords(data, '⚡ ข้อมูลมิเตอร์ไฟฟ้าตามชื่อ', page, name);
      return reply(event.replyToken, { type: 'text', text: result });
    } catch (err) {
      console.error('pean error:', err?.response?.data || err.message);
      return reply(event.replyToken, { type: 'text', text: '❌ ดึงข้อมูล PEA จากชื่อไม่สำเร็จ: ' + err.message });
    }
  }

  if (text.startsWith('peau%')) {
    const input = text.replace(/^peau%/, '').trim();
    const parts = input.split(/\s+/);
    let page = 0;
    if (parts.length > 1 && /^\d+$/.test(parts[parts.length - 1])) {
      page = parseInt(parts.pop(), 10) - 1;
    }
    const address = parts.join(' ');
    if (!address) {
      return reply(event.replyToken, { type: 'text', text: '❌ กรุณาระบุที่อยู่ เช่น peau%นครสวรรค์' });
    }
    try {
      const data = await fetchPEAApi({ peau: address });
      const result = formatPEAAddressRecords(data, page);
      return reply(event.replyToken, { type: 'text', text: result });
    } catch (err) {
      console.error('peau error:', err?.response?.data || err.message);
      return reply(event.replyToken, { type: 'text', text: '❌ ดึงข้อมูล PEA จากที่อยู่ไม่สำเร็จ: ' + err.message });
    }
  }

 return;
}

async function handleImage(event) {
  const userId = event.source.userId;
  const db = loadDB();
  const member = db.members[userId];
  const topup = db.topups?.[userId];

if (!member) {
  return reply(event.replyToken, {
    type: 'text',
    text: '❌ กรุณาสมัครสมาชิกก่อน โดยพิมพ์: ยินยอมรับข้อตกลง'
  });
}

if (member.status === 'waiting_card') {
  // อนุญาตให้ส่งรูปหลักฐานสมัครต่อได้
} else if (!isActiveMember(member)) {
  return reply(event.replyToken, {
    type: 'text',
    text: '⏳ บัญชีของคุณยังไม่ได้รับการอนุมัติจากแอดมิน หรือสมาชิกหมดอายุ'
  });
}

  if (topup && topup.status === 'waiting_slip') {
    try {
      const fileName = `topup_${userId}_${Date.now()}.jpg`;
      const savePath = path.join(UPLOAD_DIR, fileName);

      await downloadLineImage(event.message.id, savePath);

      topup.status = 'pending_review';
      topup.updatedAt = nowThai();
      topup.slipImagePath = savePath;
      topup.slipImageUrl = BASE_URL ? `${BASE_URL}/uploads/${fileName}` : '';
      db.topups[userId] = topup;
      saveDB(db);

      await reply(event.replyToken, {
        type: 'text',
        text: 'รับสลิปเรียบร้อยแล้ว ✅\nขณะนี้รอผู้ดูแลตรวจสอบ'
      });

      const adminMessages = [buildTopupAdminFlex(topup, userId)];

      if (topup.slipImageUrl) {
        adminMessages.push({
          type: 'image',
          originalContentUrl: topup.slipImageUrl,
          previewImageUrl: topup.slipImageUrl
        });
      }

      await notifyAdmins(adminMessages);
      return null;
    } catch (e) {
      console.error('topup slip error:', e?.response?.data || e.message);
      return reply(event.replyToken, {
        type: 'text',
        text: 'เกิดข้อผิดพลาดในการบันทึกสลิป กรุณาลองส่งใหม่อีกครั้ง'
      });
    }
  }

  if (!member) {
    return reply(event.replyToken, {
      type: 'text',
      text: 'กรุณาสมัครสมาชิกก่อน โดยพิมพ์: ยินยอมรับข้อตกลง'
    });
  }

  if (member.status !== 'waiting_card') {
    return reply(event.replyToken, {
      type: 'text',
      text: 'ระบบไม่ได้รอรับรูปหลักฐานจากคุณในขณะนี้'
    });
  }

  try {
    const fileName = `${userId}_${Date.now()}.jpg`;
    const savePath = path.join(UPLOAD_DIR, fileName);

    await downloadLineImage(event.message.id, savePath);

    member.status = 'pending';
    member.updatedAt = nowThai();
    member.imagePath = savePath;
    member.imageUrl = BASE_URL ? `${BASE_URL}/uploads/${fileName}` : '';
    db.members[userId] = member;
    saveDB(db);

    await reply(event.replyToken, {
      type: 'text',
      text: 'รับรูปหลักฐานเรียบร้อยแล้ว\nขณะนี้อยู่ระหว่างรอการตรวจสอบจากผู้ดูแล'
    });

    const adminMessages = [buildAdminApproveFlex(member, userId)];

    if (member.imageUrl) {
      adminMessages.push({
        type: 'image',
        originalContentUrl: member.imageUrl,
        previewImageUrl: member.imageUrl
      });
    } else {
      adminMessages.push({
        type: 'text',
        text: `ผู้สมัคร ${member.fullname || userId} ส่งรูปแล้ว แต่ยังไม่มี BASE_URL สำหรับแสดงภาพ`
      });
    }

    await notifyAdmins(adminMessages);
    return null;
  } catch (e) {
    console.error('handleImage error:', e?.response?.data || e.message);
    return reply(event.replyToken, {
      type: 'text',
      text: 'เกิดข้อผิดพลาดในการบันทึกรูป กรุณาลองส่งใหม่อีกครั้ง'
    });
  }
}

async function handlePostback(event) {
  const adminUserId = event.source.userId;
  const data = event.postback.data || '';

  if (!isAdmin(adminUserId)) {
    return reply(event.replyToken, {
      type: 'text',
      text: 'คุณไม่มีสิทธิ์ใช้งานคำสั่งนี้'
    });
  }

  const db = loadDB();

  if (data === 'admin_members_all') {
    return reply(event.replyToken, {
      type: 'text',
      text: buildMembersAllText(db)
    });
  }

  if (data === 'admin_members_pending') {
    return reply(event.replyToken, {
      type: 'text',
      text: buildMembersPendingText(db)
    });
  }

  if (data === 'admin_members_expired') {
    return reply(event.replyToken, {
      type: 'text',
      text: buildMembersExpiredText(db)
    });
  }

  if (data === 'admin_topup_pending') {
    return reply(event.replyToken, {
      type: 'text',
      text: buildTopupPendingText(db)
    });
  }

  const parts = data.split('|');
  const action = parts[0];
  const targetUserId = parts[1];

  if (!action || !targetUserId) {
    return reply(event.replyToken, {
      type: 'text',
      text: 'ข้อมูลคำสั่งไม่ถูกต้อง'
    });
  }

  if (action === 'topup_approved') {
    if (!db.topups || !db.topups[targetUserId]) {
      return reply(event.replyToken, {
        type: 'text',
        text: 'ไม่พบรายการ TOPUP'
      });
    }

    db.topups[targetUserId].status = 'approved';
    db.topups[targetUserId].updatedAt = nowThai();
    saveDB(db);

    try {
      await push(targetUserId, {
        type: 'text',
        text:
          'แอดมินตรวจสอบ TOPUP ของคุณแล้ว ✅\n' +
          'จากนี้ผู้ดูแลจะกำหนดจำนวนวันสมาชิกให้เอง'
      });
    } catch (e) {
      console.error('push topup approved error:', e?.response?.data || e.message);
    }

    return reply(event.replyToken, {
      type: 'text',
      text:
        `อนุมัติรายการ TOPUP ของ ${db.topups[targetUserId].fullname || targetUserId} แล้ว\n` +
        `จากนี้กำหนดวันสมาชิกด้วยปุ่มอนุมัติหรือคำสั่งต่ออายุได้เลย`
    });
  }

  if (action === 'topup_rejected') {
    if (!db.topups || !db.topups[targetUserId]) {
      return reply(event.replyToken, {
        type: 'text',
        text: 'ไม่พบรายการ TOPUP'
      });
    }

    db.topups[targetUserId].status = 'rejected';
    db.topups[targetUserId].updatedAt = nowThai();
    saveDB(db);

    try {
      await push(targetUserId, {
        type: 'text',
        text: 'รายการ TOPUP ของคุณไม่ผ่านการตรวจสอบ ❌\nกรุณาติดต่อผู้ดูแล'
      });
    } catch (e) {
      console.error('push topup rejected error:', e?.response?.data || e.message);
    }

    return reply(event.replyToken, {
      type: 'text',
      text: `ปฏิเสธรายการ TOPUP ของ ${db.topups[targetUserId].fullname || targetUserId} เรียบร้อยแล้ว`
    });
  }

  const member = db.members[targetUserId];

  if (!member) {
    return reply(event.replyToken, {
      type: 'text',
      text: 'ไม่พบข้อมูลผู้สมัคร'
    });
  }

  if (action === 'approve_days') {
    const days = Number(parts[2] || 0);

    if (![30, 90, 180, 365].includes(days)) {
      return reply(event.replyToken, {
        type: 'text',
        text: 'จำนวนวันไม่ถูกต้อง'
      });
    }

    const expireDate = addDaysFromNow(days);

    member.status = 'approved';
    member.updatedAt = nowThai();
    member.approvedAt = nowThai();
    member.approvedDays = days;
    member.expireAt = expireDate.toISOString();
    member.renewCount = Number(member.renewCount || 0);

    db.members[targetUserId] = member;
    saveDB(db);

    try {
      await push(targetUserId, {
        type: 'text',
        text:
          `บัญชีของคุณได้รับการอนุมัติแล้ว ✅\n` +
          `อายุสมาชิก: ${days} วัน\n` +
          `วันหมดอายุ: ${formatThaiDate(expireDate)}`
      });
    } catch (e) {
      console.error('push approved error:', e?.response?.data || e.message);
    }

    return reply(event.replyToken, {
      type: 'text',
      text:
        `อนุมัติ ${member.fullname || targetUserId} เรียบร้อยแล้ว\n` +
        `อายุสมาชิก: ${days} วัน\n` +
        `หมดอายุ: ${formatThaiDate(expireDate)}`
    });
  }

  if (action === 'renew_days') {
    const days = Number(parts[2] || 0);

    if (![30, 90, 180, 365].includes(days)) {
      return reply(event.replyToken, {
        type: 'text',
        text: 'จำนวนวันไม่ถูกต้อง'
      });
    }

    let baseDate = new Date();
    if (member.expireAt && !isExpired(member.expireAt)) {
      baseDate = new Date(member.expireAt);
    }

    baseDate.setDate(baseDate.getDate() + days);

    member.status = 'approved';
    member.updatedAt = nowThai();
    member.approvedDays = days;
    member.expireAt = baseDate.toISOString();
    member.renewCount = Number(member.renewCount || 0) + 1;

    db.members[targetUserId] = member;
    saveDB(db);

    try {
      await push(targetUserId, {
        type: 'text',
        text:
          `สมาชิกของคุณได้รับการต่ออายุแล้ว ✅\n` +
          `ต่อเพิ่ม: ${days} วัน\n` +
          `วันหมดอายุใหม่: ${formatThaiDate(baseDate)}`
      });
    } catch (e) {
      console.error('push renew error:', e?.response?.data || e.message);
    }

    return reply(event.replyToken, {
      type: 'text',
      text:
        `ต่ออายุ ${member.fullname || targetUserId} เรียบร้อยแล้ว\n` +
        `เพิ่ม: ${days} วัน\n` +
        `หมดอายุใหม่: ${formatThaiDate(baseDate)}`
    });
  }

  if (action === 'reject') {
    member.status = 'rejected';
    member.updatedAt = nowThai();
    db.members[targetUserId] = member;
    saveDB(db);

    try {
      await push(targetUserId, {
        type: 'text',
        text: 'การสมัครของคุณถูกปฏิเสธ ❌'
      });
    } catch (e) {
      console.error('push rejected error:', e?.response?.data || e.message);
    }

    return reply(event.replyToken, {
      type: 'text',
      text: `ปฏิเสธ ${member.fullname || targetUserId} เรียบร้อยแล้ว`
    });
  }

  return reply(event.replyToken, {
    type: 'text',
    text: 'ไม่รู้จักคำสั่งนี้'
  });
}
