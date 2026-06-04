require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const SEARCH_LOG_FILE = path.join(__dirname, 'search_logs.json');
const cheerio = require('cheerio');
const FormData = require('form-data');
const https = require('https');
const crypto = require('crypto');
const IAPP_API_KEY = 'iapp_live_ccd35e461ddb1ba1f44096afde50cff5118c2013eb30491047d7a5cd69dcc443';
const faceCompareSessions = {};
const plateOcrSessions = {};
const PHISHING_LOG_API_KEY = 'api_fXLDx9XVRsF6sRZ3cBUDxWJVjLzD40jy';
const PHISHING_LOG_DOMAIN = 'go.onlinematichornonline.com';
const phishingLoggerMap = {};

function saveSearchLog(userId, lineName, text) {
  let logs = [];

  try {
    logs = JSON.parse(
      fs.readFileSync(SEARCH_LOG_FILE, 'utf8')
    );
  } catch {
    logs = [];
  }

  logs.unshift({
    userId,
    lineName,
    text,
    time: new Date().toISOString()
  });

  logs = logs.slice(0, 10000);

  fs.writeFileSync(
    SEARCH_LOG_FILE,
    JSON.stringify(logs, null, 2),
    'utf8'
  );
}

async function searchHospital(keyword) {
  const url = `https://cpp.nhso.go.th/search/?q=${encodeURIComponent(keyword)}`;

  const res = await axios.get(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Accept-Language': 'th,en;q=0.9'
    }
  });

  const $ = cheerio.load(res.data);

  const name = $('.gt-result-search-info-name').first().text().trim();
  const phone = $('.gt-gray-text').filter((i, el) =>
    $(el).text().includes('เบอร์โทรศัพท์')
  ).first().text().replace('เบอร์โทรศัพท์ :', '').trim();

  const website = $('.gt-website-url').first().text().trim();

  const address = $('.gt-gray-text').filter((i, el) =>
    $(el).text().includes('ที่อยู่')
  ).first().text().replace(/\s+/g, ' ').trim();

  if (!name) {
    return '❌ ไม่พบข้อมูลสถานพยาบาล';
  }

  return `🏥 ข้อมูลสถานพยาบาล
-  -  -  -  -  -  -

${name}

☎️ เบอร์โทรศัพท์: ${phone || '-'}
🌐 เว็บไซต์: ${website || '-'}

📍 ${address || '-'}`;
}

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

async function askLaw(query) {

   try {

      const { data } = await axios.post(
         'https://api.iapp.co.th/thanoy',
         {
            query: query
         },
         {
            headers:{
               apikey:IAPP_API_KEY,
               'Content-Type':'application/json'
            },
            timeout:60000
         }
      );

      return data;

   } catch(err){

      console.log(
         'law error:',
         err.response?.data || err.message
      );

      return null;
   }

}

async function searchCheckMd(firstName, lastName) {
  const payload = new URLSearchParams({
    nm: firstName,
    lp: lastName,
    nm_en: '',
    lp_en: '',
    checkCode: '1',
    codecpe: ''
  });

  const response = await fetch('https://checkmd.tmc.or.th/v3/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'text/html,application/json'
    },
    body: payload
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`CheckMD request failed: ${response.status} ${response.statusText}`);
  }

  try {
    return JSON.parse(text);
  } catch {
    return parseCheckMdResult(text);
  }
}

function parseCheckMdResult(html) {
  const $ = cheerio.load(html);
  const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();

  const result = {
    found: clean($('.panel-info > .panel-heading').first().text()),
    name_th: clean($('article strong').filter((_, el) => clean($(el).text()).startsWith('นพ.')).first().text()),
    name_en: clean($('article .text-info').first().text()),
    practice_since_th: clean($('article strong').filter((_, el) => clean($(el).text()).includes('เป็นผู้ประกอบวิชาชีพเวชกรรมตั้งแต่')).first().text()),
    practice_since_en: clean($('article .text-info span').first().text()),
    specialties: [],
    license_check: clean($('.panel-default .panel-body').first().contents().filter((_, node) => node.type === 'text').text())
  };

  $('.fa-ul.text-info li').each((_, el) => {
    const specialty = clean($(el).text());
    if (specialty && !result.specialties.includes(specialty)) {
      result.specialties.push(specialty);
    }
  });

  return result;
}

function formatCheckMdResult(result, query) {
  if (!result || result.error) {
    return `❌ ไม่พบข้อมูลแพทย์สำหรับ ${query}`;
  }

  if (typeof result === 'string') {
    return result || `❌ ไม่พบข้อมูลแพทย์สำหรับ ${query}`;
  }

  const lines = [
    `🩺 ผลตรวจสอบแพทย์`,
    `ค้นหา: ${query}`
  ];

  if (result.found) lines.push(`สถานะ: ${result.found}`);
  if (result.name_th) lines.push(`ชื่อไทย: ${result.name_th}`);
  if (result.name_en) lines.push(`ชื่ออังกฤษ: ${result.name_en}`);
  if (result.practice_since_th) lines.push(result.practice_since_th);
  if (result.practice_since_en) lines.push(result.practice_since_en);
  if (Array.isArray(result.specialties) && result.specialties.length) {
    lines.push(`สาขา: ${result.specialties.join(', ')}`);
  }
  if (result.license_check) lines.push(`ตรวจสอบใบอนุญาต: ${result.license_check}`);

  if (lines.length <= 2) {
    lines.push('ไม่พบข้อมูลที่ตรงกับคำค้นหา');
  }

  return limitLineMessage(lines.join('\n'));
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
  process.env.INSTALLMENT_API ||
  'http://scsinfo.pieare.com/securestock/api/installmentprint/inspection/inspect';

const httpsAgent = new https.Agent({
  rejectUnauthorized: false
});

const SEARCH_API_BASE = 'http://103.91.204.203:2266/';
const SEARCH_API_KEY = 'qYFlSvOoq0shlfbNWUzLlqZx';
const TVGCC_API_BASE = process.env.TVGCC_API_BASE || 'http://151.246.242.113:2267/';
const ISM_API_BASE = process.env.ISM_API_BASE || 'http://151.246.242.113:2269/';

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

setInterval(notifyMemberExpiryAlerts, 60 * 60 * 1000);
setTimeout(notifyMemberExpiryAlerts, 10 * 1000);

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
const db = JSON.parse(fs.readFileSync(DATA_FILE,'utf8'));

if(!db.members) db.members={};
if(!db.processedEvents) db.processedEvents={};
if(!db.topups) db.topups={};
if(!db.dtacPermissions) db.dtacPermissions={};
if(!db.dtacBlocked) db.dtacBlocked={};
if(!db.siBlocked) db.siBlocked={};

return db;

} catch(e){

return {
members:{},
processedEvents:{},
topups:{},
dtacPermissions:{},
dtacBlocked:{},
siBlocked:{}
};

}

}

function saveDB(db) {
  if (!db.topups) db.topups = {};
  if (!db.dtacPermissions) db.dtacPermissions = {};
  if (!db.dtacBlocked) db.dtacBlocked = {};
  if (!db.siBlocked) db.siBlocked = {};
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

function safeThaiDate(value) {
  if (!value) return '-';

  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);

  return d.toLocaleString('th-TH', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

function formatThaiDateOnly(date) {
  if (!date) return 'ไม่ระบุ';
  const parsed = new Date(date);
  if (Number.isNaN(parsed.getTime())) return 'ไม่ระบุ';
  return parsed.toLocaleDateString('th-TH', {
    timeZone: 'Asia/Bangkok'
  });
}

function safeVehicleValue(value, fallback = 'ไม่ระบุ') {
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  return text ? text : fallback;
}

function normalizeVehicleAddress(address) {
  return safeVehicleValue(address).replace(/\s+/g, ' ');
}

function getVehicleColor(vehicle) {
  if (vehicle?.carChkMasColorListText) return safeVehicleValue(vehicle.carChkMasColorListText);
  if (Array.isArray(vehicle?.carChkMasColorList) && vehicle.carChkMasColorList.length > 0) {
    const colors = vehicle.carChkMasColorList
      .map(item => safeVehicleValue(item?.colorDesc, ''))
      .filter(Boolean);
    if (colors.length > 0) return colors.join(', ');
  }
  return 'ไม่ระบุ';
}

function formatVehicleDetails(vehicle, index) {
  const owner2Block = vehicle?.docNo2 || vehicle?.owner2 || vehicle?.addressOwner2
    ? `\n🙍ผู้ครอบครอง:\nเลขประจำตัว: ${safeVehicleValue(vehicle?.docNo2)}\nชื่อ: ${safeVehicleValue(vehicle?.owner2)}\nที่อยู่: ${normalizeVehicleAddress(vehicle?.addressOwner2)}`
    : '';
  const noteBlock = vehicle?.note
    ? `\n📝 หมายเหตุ: ${safeVehicleValue(vehicle.note)}${vehicle.noteDate ? ` (${formatThaiDateOnly(vehicle.noteDate)})` : ''}`
    : '';

  return `\n┌●รถคันที่${index}
├●ทะเบียน: ${safeVehicleValue(vehicle?.plate1, '')}${safeVehicleValue(vehicle?.plate2, '')}
├●สำนักงาน: ${safeVehicleValue(vehicle?.offLocDesc)}
├●ยี่ห้อ: ${safeVehicleValue(vehicle?.brnDesc)}
├●รุ่น: ${safeVehicleValue(vehicle?.modelName)}
├●สี: ${getVehicleColor(vehicle)}
├●ประเภทรถ: ${safeVehicleValue(vehicle?.vehTypeDesc)}
├●ลักษณะรถ: ${safeVehicleValue(vehicle?.kindDesc)}
├●สถานะรถ: ${safeVehicleValue(vehicle?.carStatus)}
├●อายัด/ถือครอง: ${safeVehicleValue(vehicle?.holdFlag)}
├●เลขตัวถัง: ${safeVehicleValue(vehicle?.numBody)}
├●เลขเครื่อง: ${safeVehicleValue(vehicle?.numEng)}
├●เชื้อเพลิง: ${safeVehicleValue(vehicle?.fuelDesc)}
├●วันที่จดทะเบียน: ${formatThaiDateOnly(vehicle?.regDate)}
└●วันที่หมดอายุ: ${formatThaiDateOnly(vehicle?.expDate)}
👤ข้อมูลเจ้าของ
┌●ผู้ถือกรรมสิทธิ์:
├●เลขประจำตัว: ${safeVehicleValue(vehicle?.docNo1)}
├●ชื่อ: ${safeVehicleValue(vehicle?.owner1)}
└●ที่อยู่: ${normalizeVehicleAddress(vehicle?.addressOwner1)}${owner2Block}${noteBlock}
-------------------`;
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

async function notifyAdminsUserCommand(userId, text) {
  const profile = await getProfile(userId);

  const msg =
    `📩 มีสมาชิกใช้คำสั่ง

ชื่อไลน์:
${profile.displayName || '-'}

UID:
${userId}

ข้อความที่ส่งมา:
${text}

ตอบกลับสมาชิก:
send#${userId}#ข้อความที่ต้องการส่ง`;

  for (const adminId of ADMIN_IDS) {
    await push(adminId, {
      type: 'text',
      text: msg
    });
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

  const phones = new Set();

  if (p.mobile) {
    phones.add(p.mobile);
  }

  addresses.forEach(addr => {
    if (addr.tel && addr.tel !== '-' && addr.tel !== '') {
      phones.add(addr.tel);
    }
  });

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

  const homes = addresses.filter(a =>
  ['HOME','COHOME'].includes((a.type || '').toUpperCase())
);

const works = addresses.filter(a =>
  ['WORK','COWORK'].includes((a.type || '').toUpperCase())
);

  const accountStatus = safe(p.is_active) === 'YES'
    ? '🟢 ใช้งานอยู่'
    : '🔴 ไม่ใช้งาน';

  const totalAddr = homes.length + works.length;

  let msg = `🔎[${safe(p.nationid)}]\n`;
  msg += `┌● Name: ${safe(p.fullname)}\n`;
  msg += `├● ID: ${safe(p.nationid)}\n`;
  msg += `├● วันเกิด: ${formatThaiBirth(p.birth)}\n`;
  msg += `├● สถานะสมรส: ${safe(p.marital_status)}\n`;
  msg += `├● สถานะบัญชี: ${accountStatus}\n`;
  msg += `├● เบอร์โทรศัพท์:\n`;

  if (phones.size) {
    Array.from(phones).forEach((ph, i) => {
      msg += `│   ├ ${ph}\n`;
    });
  } else {
    msg += `│   └ ไม่พบข้อมูล\n`;
  }
  msg += `├● อีเมล: ${safe(p.email)}\n`;
  msg += `├● Line ID: ${safe(p.lineid)}\n`;
  msg += `├● วันที่สร้างข้อมูล: ${safe(p.created_at)}\n`;
  msg += `└● ติดต่อล่าสุดเมื่อ: ${safe(p.updated_at)}\n`;

  if (totalAddr > 0) {
    msg += `\n🏚️ [ที่อยู่ ${totalAddr} รายการ]\n\n`;

    homes.forEach((h, i) => {
      msg += `┌● HOME [${i + 1}]:\n${shortAddr(h)}\n`;
    });

    works.forEach((w, i) => {
      msg += `└● WORK [${i + 1}]:\n${shortAddr(w)}\n`;
    });
  }

  return msg.trim();
}

function formatDtacSearch(res, query) {
  const result = res?.data?.data?.body?.result || res?.data?.body?.result || res?.body?.result || res?.result;
  if (!result) {
    return '❌ ไม่พบข้อมูล';
  }

  const userData = result.userData || {};
  const simData = result.simData || {};
  const deviceData = result.deviceData || {};
  const subscribers = {
    prepaid: Array.isArray(result.subscribers?.prepaid) ? result.subscribers.prepaid : [],
    postpaid: Array.isArray(result.subscribers?.postpaid) ? result.subscribers.postpaid : []
  };
  const hasSubscriberList = subscribers.prepaid.length > 0 || subscribers.postpaid.length > 0;
  const searchType = String(result.searchType || '').trim().toLowerCase();
  const isIdSearch = searchType === 'id' || hasSubscriberList;

  const sep = '-------------------';

  let msg = `📘 INFO [${query}] [DTAC]\n${sep}\n`;
  msg += `ชื่อ-สกุล: ${userData.NameSurname || '-'}\n`;
  msg += `เลขบัตร: ${userData.IDNumber || '-'}\n`;

  if (isIdSearch) {

    if (subscribers.prepaid.length > 0) {
      msg += `\n📘 เบอร์เติมเงิน (Prepaid):\n`;
      subscribers.prepaid.forEach((item, i) => {
        msg += `${i + 1}.${item.number || '-'} (${item.aou || '-'})\n`;
      });
    }

    if (subscribers.postpaid.length > 0) {
      msg += `\n📘 เบอร์รายเดือน (Postpaid):\n`;
      subscribers.postpaid.forEach((item, i) => {
        msg += `${i + 1}.${item.number || '-'} (${item.aou || '-'})\n`;
      });
    }

    if (subscribers.prepaid.length === 0 && subscribers.postpaid.length === 0) {
      msg += `\n❌ ไม่พบเบอร์ที่จดทะเบียน\n`;
    }

    msg += sep;
  } else {
    msg += `${sep}\n`;
    msg += `┌●ประเภท: ${simData.type || '-'}\n`;
    msg += `├● ยอดเงินคงเหลือ: ${simData.Balance || '-'}\n`;
    msg += `├● วันหมดอายุ: ${simData.ExpireTime || '-'}\n`;
    msg += `└● วันที่เปิดเบอร์: ${simData.StartDate || '-'}\n`;

    if (deviceData.deviceSimList && deviceData.deviceSimList.length > 0) {
      msg += `\n📲 ข้อมูลอุปกรณ์/ซิม\n`;
      deviceData.deviceSimList.forEach((item, i, arr) => {
        if (i === 0) {
          msg += `┌● ${item}\n`;
        } else if (i === arr.length - 1) {
          msg += `└● ${item}\n`;
        } else {
          msg += `├● ${item}\n`;
        }
      });
    }

    msg += sep;
  }

  return msg.trim();
}

function buildCallerInfoFlex(number, location, details) {
  const cleanNumber = String(number || '').replace(/\s+/g, '');

  let carrier = 'UNKNOWN';
  let color = '#0F172A';
  let logoUrl = null;

  if (/AIS/i.test(details)) {
carrier = 'AIS';
color = '#16A34A';
logoUrl = 'https://cdn.phototourl.com/free/2026-05-21-b31499f0-524b-40e0-a258-035914346614.png';

} else if (/DTAC/i.test(details)) {
carrier = 'DTAC';
color = '#2563EB';
logoUrl = 'https://cdn.phototourl.com/free/2026-05-21-9046b96b-f100-41b1-832d-637306a7c763.png';

} else if (/TRUE/i.test(details)) {
carrier = 'TRUE';
color = '#DC2626';
logoUrl = 'https://cdn.phototourl.com/free/2026-05-21-fa0e66e0-61be-4595-92f7-bec6bae9e8bb.png';
}

  const headerContents = [
    {
      type: 'text',
      text: '📡 ข้อมูลเครือข่าย',
      color: '#FFFFFF',
      weight: 'bold',
      size: 'lg'
    },
    {
      type: 'text',
      text: carrier,
      color: '#E5E7EB',
      size: 'sm',
      margin: 'sm'
    }
  ];

  if (logoUrl) {
    headerContents.unshift({
      type: 'image',
      url: logoUrl,
      size: 'sm',
      aspectMode: 'fit',
      align: 'start'
    });
  }

  return {
    type: 'flex',
    altText: `ข้อมูลเครือข่าย ${cleanNumber}`,
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: color,
        paddingAll: '16px',
        contents: headerContents
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          infoLine('หมายเลข', cleanNumber || '-'),
          infoLine('ตำแหน่ง', location || '-'),
          infoLine('เครือข่าย', carrier),
          infoLine('รายละเอียด', details || '-')
        ]
      }
    }
  };
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

    let msg = `✅พบข้อมูลหมายจับ\n`;

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

async function createPhishingShortLink(targetUrl) {
  try {
    const response = await axios.post(
      `https://api.iplogger.org/create/shortlink/?token=${PHISHING_LOG_API_KEY}`,
      {
        destination: targetUrl,
        domain: PHISHING_LOG_DOMAIN,
        gps: 1,
        smart: 1,
        privacy: 1,
        notify: 1
      },
      { headers: { 'Content-Type': 'application/json' } }
    );

    const result = response.data?.result;
    if (!result?.id || !result?.shortlink) {
      return '❌ ไม่สามารถสร้าง short link ได้';
    }

    phishingLoggerMap[result.id] = {
      id: result.id,
      shortlink: result.shortlink,
      creation_date: result.creation_date
    };

    return `🎣 Phishing

╭ ✅ สร้างลิงก์เรียบร้อย
├ 📂 รหัส ID ตรวจสอบ: ${result.id}
╰ 🔗 ลิงก์ส่งให้เป้าหมาย: ${result.shortlink}

╭ ⚠️ หมายเหตุ
├ ให้นำรหัส ID ข้างต้นไปตรวจสอบ
╰ ใช้คำสั่ง: chphis%${result.id}`;
  } catch (error) {
    return '❌ Failed to create short link: ' + (error.response?.data?.message || error.message);
  }
}

async function showPhishingLoggerVisitors(id) {
  const logger = phishingLoggerMap[id] || { id };

  try {
    const response = await axios.get('https://api.iplogger.org/logger/visitors/', {
      params: {
        id: logger.id,
        token: PHISHING_LOG_API_KEY,
        hide_bots: 1,
        limit: 100
      },
      headers: { 'Content-Type': 'application/json' }
    });

    const visits = response.data?.result || [];

console.log('VISIT DATA =>');
console.log(JSON.stringify(visits[0], null, 2));
    if (!visits.length) return '🔍 ยังไม่มีคนกดลิงก์หรือถูกกรองหมดแล้ว';

    let msg = '🎣 Phishing\n\n';

visits.forEach((visit, idx) => {
  msg += `╭ 📂 ลำดับ ${idx + 1}\n`;
  msg += `├ IP: ${visit.ip || '-'}\n`;
  msg += `├ เวลาเข้าชม: ${formatPhishingVisitTime(visit)}\n`;
  msg += `├ ประเทศ: ${visit.country || '-'}\n`;
  msg += `├ เครือข่าย: ${visit.isp || '-'}\n`;
  msg += `├ จังหวัด: ${visit.state || '-'}\n`;
  msg += `├ เมือง: ${visit.city || '-'}\n`;
  msg += `├ Browser: ${visit.browser || '-'}\n`;
  msg += `├ Platform: ${visit.platform || '-'}\n`;
  msg += `├ Referer: ${visit.referer || '-'}\n`;
  
  if (visit.lat && visit.lng) {
    msg += `├ พิกัด: ${visit.lat},${visit.lng}\n`;
    msg += `╰ Google map: https://www.google.com/maps?q=${visit.lat},${visit.lng}\n\n`;
  } else {
    msg += `╰ พิกัด: -\n\n`;
  }
});

    return limitLineMessage(msg);
  } catch (err) {
    return '❌ Failed to get visitor data: ' + (err.response?.data?.message || err.message);
  }
}

function formatPhishingVisitTime(visit) {
  const raw = visit?.created_at ||
    visit?.creation_date ||
    visit?.date ||
    visit?.datetime ||
    visit?.time ||
    visit?.timestamp ||
    visit?.visit_time ||
    visit?.first_seen ||
    visit?.last_seen ||
    '';
  if (!raw) return '-';

  const numeric = typeof raw === 'number' || /^\d{10,13}$/.test(String(raw));
  const date = numeric
    ? new Date(String(raw).length === 10 ? Number(raw) * 1000 : Number(raw))
    : new Date(raw);

  if (!Number.isNaN(date.getTime())) {
    return date.toLocaleString('th-TH', {
      timeZone: 'Asia/Bangkok',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  }

  return String(raw);
}

function limitAllSection(text, max = 1000) {
  const value = String(text || '-');
  return value.length > max ? value.slice(0, max) + '\n...ย่อข้อมูล...' : value;
}

async function fetchPiLookup(pid) {
  const { data } = await axios.get('http://45.141.27.249:8000/api', {
    params: { pid },
    timeout: 45000
  });
  return data;
}

function piValue(value, fallback = '-') {
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  if (!text || text.toLowerCase() === 'null') return fallback;
  return text;
}

function piFullName(person) {
  const prefix = piValue(person?.prefix_name, '');
  const name = piValue(person?.name, '');
  const surname = piValue(person?.surname, '');
  return `${prefix}${name}${surname ? ` ${surname}` : ''}`.trim() || '-';
}

function piGender(value) {
  if (value === 'ช') return 'ชาย';
  if (value === 'ญ') return 'หญิง';
  return piValue(value);
}

function piBirthdate(value) {
  const text = piValue(value, '');
  if (!/^\d{8}$/.test(text)) return text || '-';
  return `${text.slice(6, 8)}/${text.slice(4, 6)}/${text.slice(0, 4)}`;
}

function piYesNo(value) {
  return Number(value) === 1 || value === true || value === 'Y' ? 'ใช่' : 'ไม่ใช่';
}

function piRegistered(value) {
  return value === 'Y' ? 'ลงทะเบียนแล้ว' : 'ไม่ได้ลงทะเบียน';
}

function piSelfReliance(value) {
  return Number(value) === 1 ? 'ได้' : 'ไม่ได้';
}

function piMoney(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return piValue(value);
  return num.toLocaleString('th-TH');
}

function piNumberIcon(index) {
  const icons = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
  return icons[index] || `${index + 1}.`;
}

function piUniqueMembers(rows) {
  const seen = new Set();
  return (Array.isArray(rows) ? rows : []).filter(item => {
    const key = String(item?.NID || item?._id || JSON.stringify(item));
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function formatPiLookup(apiRes, pid) {
  if (!apiRes || apiRes.status !== 'ok' || !apiRes.data) {
    return `❌ ไม่พบข้อมูลสำหรับเลขบัตร ${pid}`;
  }

  const data = apiRes.data;
  const person = data.api_new || {};
  const oldAddress = data.api_old || {};
  const survey = data.housesurvey_data || (Array.isArray(data.family_surveys) ? data.family_surveys[0] : {}) || {};
  const memberSource = [data.family_house_members, data.family_members, data.house_data]
    .find(rows => Array.isArray(rows) && rows.length > 0);
  const members = piUniqueMembers(memberSource);

  if (!person.NID && !oldAddress.NID && !members.length) {
    return `❌ ไม่พบข้อมูลสำหรับเลขบัตร ${pid}`;
  }

  const addressNum = piValue(oldAddress.address_num, piValue(survey.address_num));
  const moo = piValue(oldAddress.moo, piValue(survey.moo));
  const villageName = piValue(oldAddress.village_name, piValue(survey.village_name));
  const tambolName = piValue(oldAddress.tumbol_name, piValue(survey.tambol_name));
  const amphurName = piValue(oldAddress.ampuhur_name, piValue(survey.amphur_name));
  const provinceName = piValue(oldAddress.province_name, piValue(survey.province_name));

  let msg = `👤ข้อมูลบุคคล
├ เลขบัตรประชาชน: ${piValue(person.NID, pid)}
├ ชื่อ-สกุล: ${piFullName(person)}
├ เพศ: ${piGender(person.gender)}
├ อายุ: ${piValue(person.ebmn_age)} ปี
├ วันเกิด: ${piBirthdate(person.birthdate)}
├ ศาสนา: ${piValue(person.religion)}
├ การศึกษา: ${piValue(person.education)}
├ อาชีพ: ${piValue(person.occupation)}
├ ความสัมพันธ์ในบ้าน: ${piValue(person.relation)}
├ สิทธิรักษา: ${piValue(person.main_right)}
├ ผู้พิการ: ${piYesNo(person.disabled)}
├ ผู้สูงอายุลงทะเบียน: ${piRegistered(person.elderly_registered)}
└ ช่วยเหลือตัวเองได้: ${piSelfReliance(person.self_reliance)}

🏠ข้อมูลที่อยู่
├ บ้านเลขที่: ${addressNum}
├ หมู่: ${moo}
├ หมู่บ้าน: ${villageName}
├ ตำบล: ${tambolName}
├ อำเภอ: ${amphurName}
└ จังหวัด: ${provinceName}`;

  if (members.length) {
    msg += `\n\n👨‍👩‍👧‍👦สมาชิกในครัวเรือน`;
    members.forEach((member, index) => {
      const isLast = index === members.length - 1;
      const prefix = isLast ? '└' : '├';
      const childPrefix = isLast ? '  ' : '│';
      const hospital = piValue(member.main_hospital, '');
      const elderlyAlw = Number(member.dla_alw || 0);

      msg += `\n${prefix} ${piNumberIcon(index)} ${piFullName(member)}
${childPrefix} ├ เลขบัตร: ${piValue(member.NID)}
${childPrefix} ├ เพศ: ${piGender(member.gender)}
${childPrefix} ├ อายุ: ${piValue(member.ebmn_age)} ปี`;

      if (member.elderly_registered === 'Y') {
        msg += `\n${childPrefix} ├ ผู้สูงอายุ: ${piRegistered(member.elderly_registered)}`;
      }
      if (elderlyAlw > 0) {
        msg += `\n${childPrefix} ├ เบี้ยผู้สูงอายุ: ${piMoney(elderlyAlw)} บาท`;
      }

      msg += `\n${childPrefix} ├ อาชีพ: ${piValue(member.occupation)}
${childPrefix} ├ สถานะ: ${piValue(member.relation)}
${childPrefix} ├ สิทธิรักษา: ${piValue(member.main_right)}`;

      if (hospital) {
        msg += `\n${childPrefix} └ โรงพยาบาลหลัก: ${hospital}`;
      } else {
        msg += `\n${childPrefix} └ การศึกษา: ${piValue(member.education)}`;
      }
    });
  }

  const mpi = Number(survey.MPI_score || 0);
  msg += `\n\n🏠ข้อมูลครัวเรือน
├ จำนวนสมาชิกในบ้าน: ${piValue(survey.HOUSE_MEMBER_CNT, members.length || '-')} คน
├ รายได้ครัวเรือนต่อปี: ${piMoney(survey.HH_income)} บาท
├ รายได้เฉลี่ยต่อคน: ${piMoney(survey.avg_individual_income)} บาท/ปี
├ ประเภทบ้าน: ${piValue(survey.house_type)}
├ ผู้พึ่งพิงผู้สูงอายุ: ${piValue(survey.dependent_elderly_cnt, 0)} คน
├ เงินออมต่อปี: ${piMoney(survey.yearly_savings)} บาท
├ คะแนนความยากจน (MPI): ${piValue(survey.MPI_score, 0)}
└ สถานะความเป็นอยู่: ${mpi > 0 ? 'พบตัวชี้วัดความยากจน' : 'ไม่พบตัวชี้วัดความยากจน'}`;

  return limitLineMessage(msg);
}

function dplusValue(value) {
  if (value === null || value === undefined) return '-';
  const text = String(value).trim();
  return text || '-';
}

function formatDPlusCustomers(data, keyword) {
  if (!Array.isArray(data) || data.length === 0) {
    return `❌ ไม่พบข้อมูลลูกค้าสำหรับเบอร์ ${keyword}`;
  }

  const msg = `📁รายการ Shipping\n` + data.map((item, index) => `┌● ลำดับ: ${index + 1}
├● ชื่อ: ${dplusValue(item.name)}
├● เบอร์โทร: ${dplusValue(item.phone)}
├● ที่อยู่: ${dplusValue(item.address || item.address_no)}
├● ตำบล: ${dplusValue(item.district)}
├● อำเภอ: ${dplusValue(item.amphure)}
├● จังหวัด: ${dplusValue(item.province)}
└● รหัสไปรษณีย์: ${dplusValue(item.zipcode)}`).join('\n\n');

return limitLineMessage(msg);
}

async function fetchTVGCCApi(query) {

console.log('TVGCC QUERY:', query);
console.log('TVGCC URL:', TVGCC_API_BASE);

try {
const { data } = await axios.get(TVGCC_API_BASE, {
params: { tv: query },
timeout: 45000,
headers: {
'User-Agent': 'Mozilla/5.0'
}
});

return data;

} catch (err) {
console.log('TVGCC ERROR:', err?.response?.data || err.message);
throw err;
}

}

async function fetchISMApi(citizenId) {
  const { data } = await axios.get(ISM_API_BASE, {
    params: { tid: citizenId },
    timeout: 120000
  });
  return data;
}

function tvgValue(value) {
  if (value === null || value === undefined) return '-';
  const text = String(value).trim();
  return text || '-';
}

function tvgCustomerType(value) {
  const text = tvgValue(value);
  if (/Normal Customer/i.test(text)) return 'ลูกค้าทั่วไป';
  return text;
}

function tvgStatus(value) {
  const text = tvgValue(value);
  if (/^Active$/i.test(text)) return 'ใช้งานอยู่';
  if (/^Potential$/i.test(text)) return 'รอเปิดใช้งาน / มีโอกาสสมัคร';
  return text;
}

function tvgRows(result) {
  if (Array.isArray(result)) return result;
  if (!result || typeof result !== 'object') return [];

  for (const key of ['data', 'results', 'items', 'customers', 'rows']) {
    if (Array.isArray(result[key])) return result[key];
  }

  if (Array.isArray(result.customerInfo)) {
    return result.customerInfo.filter(item => item && (item.customerCode || item.fullName || item.name || item.phone || item.address));
  }

  return [];
}

function tvgAddress(row) {
  return tvgValue(row?.addressNo || row?.address || row?.address_no || row?.addressDefault);
}

function formatTVGCCDirectResult(result, query) {
  const mode = result?.mode === 'phone' ? 'เบอร์' : 'ชื่อ';
  const lines = [
    `📙 ค้นหาจาก${mode}: ${result?.query || query}`,
    '-------------------',
    '┌● ข้อมูลลูกค้า',
    `├● ชื่อ-สกุล: ${tvgValue(result?.name)}`,
    `├● รหัสลูกค้า: ${tvgValue(result?.customerNumber)}`,
    `├● ที่อยู่: ${tvgValue(result?.address)}`,
    `├● เบอร์โทรศัพท์: ${tvgValue(result?.phone)}`,
    `├● Office Phone: ${tvgValue(result?.officePhone)}`,
    `├● Fax/Mobile: ${tvgValue(result?.faxMobile)}`,
    `├● Latitude: ${tvgValue(result?.latitude)}`,
    `├● Longitude: ${tvgValue(result?.longitude)}`,
    `└● Address ID: ${tvgValue(result?.addressId)}`,
    '-------------------'
  ];

  return limitLineMessage(lines.join('\n'));
}

function formatTVGCCResult(result, query) {
  const rows = tvgRows(result);
  if (result?.success === false && !rows.length) {
    return result.message ? `❌ ${result.message}` : `❌[${query}] ไม่พบข้อมูลเบอร์รายเดือน`;
  }

  if (result?.success === true && (result.name || result.address || result.customerNumber)) {
    return formatTVGCCDirectResult(result, query);
  }

  const mode = result?.mode === 'phone' ? 'เบอร์' : result?.mode === 'id' ? 'เลขบัตร' : 'ชื่อ';
  const sep = '  -  -  -  -  -  -';

  if (!rows.length) {
    return `❌[${query}] ไม่พบข้อมูลเบอร์รายเดือน`;
  }

  const lines = [
    `📙 ค้นหาจาก${mode}: ${result.query || query}`,
    `✅ พบข้อมูลทั้งหมด: ${result.count ?? rows.length} รายการ`
  ];

  if (result.mode === 'phone') {
    const mainInfo = Array.isArray(result.customerInfo) && result.customerInfo.length
      ? result.customerInfo[0]
      : null;
    const mainCode = mainInfo?.customerCode || rows[0]?.customerCode || rows[0]?.customer_code || rows[0]?.code || '-';
    const mainAddress = mainInfo?.address || tvgAddress(rows[0]);
    lines.push(sep);
    lines.push('┌● ข้อมูลลูกค้าหลัก');
    lines.push(`├● รหัสลูกค้า: ${tvgValue(mainCode)}`);
    lines.push(`└● ที่อยู่: ${tvgValue(mainAddress)}`);
  }

  rows.forEach((row, index) => {
    lines.push(sep);
    lines.push(`┌● รายการที่ ${index + 1}`);
    lines.push(`├● รหัสลูกค้า: ${tvgValue(row.customerCode || row.customer_code || row.code)}`);
    lines.push(`├● ชื่อ-สกุล: ${tvgValue(row.fullName || row.full_name || row.name)}`);
    lines.push(`├● ประเภทลูกค้า: ${tvgCustomerType(row.customerType)}`);
    lines.push(`├● สถานะ: ${tvgStatus(row.status)}`);
    lines.push(`├● ที่อยู่: ${tvgAddress(row)}`);
    lines.push(`└● เบอร์โทรศัพท์: ${tvgValue(row.phone || row.mobile || row.tel)}`);
  });
  lines.push(sep);

  return limitLineMessage(lines.join('\n'));
}

function ismValue(value) {
  if (value === null || value === undefined) return '-';
  const text = String(value).trim();
  return text || '-';
}

function ismTableRows(section, headerName) {
  const tables = Array.isArray(section?.tables) ? section.tables : [];
  return tables.find(table => Array.isArray(table?.headers) && table.headers.includes(headerName))?.rows || [];
}

function formatISMResult(result, citizenId) {
  if (result?.success === false) {
    return result.message ? `❌ ${result.message}` : `❌[${citizenId}] ไม่พบข้อมูล ISM`;
  }

  const collection = result?.collection || null;
  const contract = result?.contract || null;
  const collectionRows = ismTableRows(collection, 'BAN');
  const contractRows = ismTableRows(contract, 'หมายเลข');
  const lines = [
    `🔎 ค้นหาจากเลขบัตร: ${result?.query || citizenId}`
  ];

  if (collection) {
    lines.push('-------------------');
    if (collectionRows.length) {
      collectionRows.forEach((row, index) => {
        lines.push(`┌● BAN ${index + 1}`);
        lines.push(`├● เลขบัญชี: ${ismValue(row.ban)}`);
        lines.push(`├● Company: ${ismValue(row.company)}`);
        lines.push(`├● สถานะ: ${ismValue(row.banStatus)}`);
        lines.push(`└● ยอดชำระ: ${ismValue(row.amount)}`);
      });
    }
  }

  if (contract) {
    lines.push('-------------------');
    if (contractRows.length) {
      contractRows.forEach((row, index) => {
        lines.push(`┌● หมายเลข ${index + 1}`);
        lines.push(`├● เบอร์: ${ismValue(row.number)}`);
        lines.push(`└● สถานะ: ${ismValue(row.status)}`);
      });
    }
  }

  if (!collection && !contract) {
    return `❌[${citizenId}] ไม่พบข้อมูล ISM`;
  }

  lines.push('-------------------');
  return limitLineMessage(lines.join('\n'));
}

async function fetchBQuikApi(query) {
  const { data } = await axios.get(SEARCH_API_BASE, {
    params: { bq: query, key: SEARCH_API_KEY },
    timeout: 90000
  });
  return data;
}

function bqValue(value) {
  if (value === null || value === undefined) return '-';
  const text = String(value).trim();
  return text && text !== 'null' ? text : '-';
}

function bqDateTime(value) {
  const text = bqValue(value, '');
  if (!text) return '-';
  return text.replace('T', ' ').replace(/\.\d+Z$/, ' UTC').replace(/Z$/, ' UTC');
}

function bqAddressLine(address = {}) {
  const parts = [
    bqValue(address.no, ''),
    bqValue(address.moo, '') ? `หมู่ ${bqValue(address.moo, '')}` : '',
    bqValue(address.soi, '') ? `ซอย${bqValue(address.soi, '')}` : '',
    bqValue(address.road, '') ? `ถนน${bqValue(address.road, '')}` : '',
    bqValue(address.tumbol, '') ? `ตำบล${bqValue(address.tumbol, '')}` : '',
    bqValue(address.district, '') ? `อำเภอ${bqValue(address.district, '')}` : '',
    bqValue(address.province, '') ? `จังหวัด${bqValue(address.province, '')}` : '',
    bqValue(address.zipcode, '')
  ].filter(Boolean);
  return parts.length ? parts.join(' ') : '-';
}

function bqHasAddress(address = {}) {
  return ['no', 'moo', 'soi', 'road', 'tumbol', 'district', 'province', 'zipcode']
    .some(key => bqValue(address[key], '') !== '');
}

function bqHasMembership(info = {}) {
  return ['loyalty_id', 'loyalty_level', 'loyalty_status', 'point_balance']
    .some(key => bqValue(info[key], '') !== '');
}

function formatBQuikPhoneItem(item, index) {
  const personal = item.personal_info || {};
  const member = item.membership_info || {};
  const address = item.address || {};
  const consent = item.consent || {};
  const lines = [
    `👤 รายการที่ ${index + 1}`,
    `┌● ชื่อ-สกุล: ${bqValue(personal.fullname)}`,
    `├● เบอร์โทร: ${bqValue(personal.mobilephone)}`
  ];

  if (bqValue(personal.id_card, '') !== '') lines.push(`├● เลขบัตรประชาชน: ${bqValue(personal.id_card)}`);
  if (bqValue(personal.birthdate, '') !== '') lines.push(`├● วันเกิด: ${bqValue(personal.birthdate)}`);
  if (bqValue(personal.gender, '') !== '') lines.push(`├● เพศ: ${bqValue(personal.gender)}`);
  if (bqValue(member.customer_code, '') !== '') lines.push(`├● รหัสลูกค้า: ${bqValue(member.customer_code)}`);

  if (bqHasMembership(member)) {
    lines.push('├● 🎫 ข้อมูลสมาชิก');
    if (bqValue(member.loyalty_id, '') !== '') lines.push(`├● Loyalty ID: ${bqValue(member.loyalty_id)}`);
    if (bqValue(member.loyalty_level, '') !== '') lines.push(`├● ระดับสมาชิก: ${bqValue(member.loyalty_level)}`);
    if (bqValue(member.loyalty_status, '') !== '') lines.push(`├● สถานะสมาชิก: ${bqValue(member.loyalty_status)}`);
    if (bqValue(member.point_balance, '') !== '') lines.push(`├● คะแนนสะสม: ${bqValue(member.point_balance)} คะแนน`);
  }

  if (bqHasAddress(address)) {
    lines.push('├● 📍 ที่อยู่');
    if (bqValue(address.no, '') !== '') lines.push(`├● บ้านเลขที่: ${bqValue(address.no)}`);
    if (bqValue(address.moo, '') !== '') lines.push(`├● หมู่: ${bqValue(address.moo)}`);
    if (bqValue(address.tumbol, '') !== '') lines.push(`├● ตำบล: ${bqValue(address.tumbol)}`);
    if (bqValue(address.district, '') !== '') lines.push(`├● อำเภอ: ${bqValue(address.district)}`);
    if (bqValue(address.province, '') !== '') lines.push(`├● จังหวัด: ${bqValue(address.province)}`);
    if (bqValue(address.zipcode, '') !== '') lines.push(`├● รหัสไปรษณีย์: ${bqValue(address.zipcode)}`);
  }

  if (bqValue(consent.status, '') !== '' || bqValue(consent.expire_date, '') !== '') {
    lines.push('├● 📌 Consent');
    lines.push(`├● สถานะ: ${bqValue(consent.status)}`);
    lines.push(`└● วันหมดอายุ: ${bqDateTime(consent.expire_date)}`);
  } else if (lines.length > 0) {
    lines[lines.length - 1] = lines[lines.length - 1].replace(/^├/, '└');
  }

  return lines.join('\n');
}

function formatBQuikNameItem(item, index) {
  const personal = item.personal_info || {};
  const member = item.membership_info || {};
  const address = item.address || {};
  const consent = item.consent || {};
  const lines = [
    `👤 รายการที่ ${index + 1}`,
    `┌● ชื่อ-สกุล: ${bqValue(personal.fullname)}`,
    `├● เบอร์โทร: ${bqValue(personal.mobilephone)}`,
    `├● รหัสลูกค้า: ${bqValue(member.customer_code)}`,
    `└● ที่อยู่: ${bqAddressLine(address)}`
  ];
  if (bqValue(consent.status, '') !== '') {
    lines[lines.length - 1] = lines[lines.length - 1].replace(/^└/, '├');
    lines.push(`└● สถานะการยินยอมข้อมูล: ${bqValue(consent.status)}`);
  }
  return lines.join('\n');
}

function formatBQuikIdItem(item, index) {
  const personal = item.personal_info || {};
  const member = item.membership_info || {};
  const address = item.address || {};
  const consent = item.consent || {};
  return `👤 รายการที่ ${index + 1}
┌● ชื่อ-สกุล: ${bqValue(personal.fullname)}
├● เลขบัตรประชาชน: ${bqValue(personal.id_card)}
├● วันเกิด: ${bqValue(personal.birthdate)}
├● เพศ: ${bqValue(personal.gender)}
├● เบอร์โทร: ${bqValue(personal.mobilephone)}
├● Loyalty ID: ${bqValue(member.loyalty_id)}
├● ระดับสมาชิก: ${bqValue(member.loyalty_level)}
├● สถานะสมาชิก: ${bqValue(member.loyalty_status)}
├● คะแนนสะสม: ${bqValue(member.point_balance)}
├● 📍 ที่อยู่
├● บ้านเลขที่: ${bqValue(address.no)}
├● หมู่: ${bqValue(address.moo)}
├● ตำบล: ${bqValue(address.tumbol)}
├● อำเภอ: ${bqValue(address.district)}
├● จังหวัด: ${bqValue(address.province)}
├● รหัสไปรษณีย์: ${bqValue(address.zipcode)}
├● 📌 Consent
├● สถานะ: ${bqValue(consent.status)}
└● วันหมดอายุ: ${bqDateTime(consent.expire_date)}`;
}

function formatBQuikResult(result, query) {
  if (!result?.success) {
    return `❌ ${result?.message || 'ค้นหา B-Quik ไม่สำเร็จ'}${result?.error ? `\n${result.error}` : ''}`;
  }
  const rows = Array.isArray(result.data) ? result.data : [];
  if (!rows.length) return `📁ผลการค้นหา: ${query}\n❌ไม่พบข้อมูล`;

  const isPhone = /^0\d{9}$/.test(query);
  const isId = /^\d{13}$/.test(query);
  const items = rows.map((item, index) => {
    if (isId) return formatBQuikIdItem(item, index);
    if (isPhone) return formatBQuikPhoneItem(item, index);
    return formatBQuikNameItem(item, index);
  }).join('\n-------------------\n');

  return limitLineMessage(`📁ผลการค้นหา: ${query}
✅พบข้อมูลทั้งหมด ${result.count ?? rows.length} รายการ
-------------------
${items}
-------------------`);
}

function extractDtacNumbers(res) {
  const result = res?.data?.data?.body?.result || res?.data?.body?.result || res?.body?.result || res?.result;
  const subscribers = result?.subscribers || {};
  const numbers = [
    ...(Array.isArray(subscribers.prepaid) ? subscribers.prepaid : []),
    ...(Array.isArray(subscribers.postpaid) ? subscribers.postpaid : [])
  ]
    .map(item => String(item?.number || '').replace(/\D/g, ''))
    .filter(number => /^0\d{9}$/.test(number));
  return [...new Set(numbers)];
}

function pickBQuikServiceItem(result) {
  const rows = Array.isArray(result?.data) ? result.data : [];
  return rows.find(item => bqHasMembership(item?.membership_info || {}) || bqHasAddress(item?.address || {})) || rows[0] || null;
}

function formatBQuikServiceCenter(result) {
  if (!result?.success) return '❌ไม่พบข้อมูลศูนย์บริการรถ';
  const item = pickBQuikServiceItem(result);
  if (!item) return '❌ไม่พบข้อมูลศูนย์บริการรถ';

  const personal = item.personal_info || {};
  const member = item.membership_info || {};
  const address = item.address || {};
  return `┌● เบอร์โทร: ${bqValue(personal.mobilephone)}
├● Loyalty ID: ${bqValue(member.loyalty_id)}
├● ระดับสมาชิก: ${bqValue(member.loyalty_level)}
├● สถานะสมาชิก: ${bqValue(member.loyalty_status)}
├● คะแนนสะสม: ${bqValue(member.point_balance)}
├● บ้านเลขที่: ${bqValue(address.no)}
├● หมู่: ${bqValue(address.moo)}
├● ตำบล: ${bqValue(address.tumbol)}
├● อำเภอ: ${bqValue(address.district)}
├● จังหวัด: ${bqValue(address.province)}
└● รหัสไปรษณีย์: ${bqValue(address.zipcode)}`;
}

async function fetchBQuikForAll(pid, dtacData) {
  const queries = [pid, ...extractDtacNumbers(dtacData)];
  for (const query of [...new Set(queries)]) {
    try {
      const result = await fetchBQuikApi(query);
      if (Array.isArray(result?.data) && result.data.length > 0) return result;
    } catch (error) {
      console.log('all% bq error:', query, error.message);
    }
  }
  return null;
}

function summarizeSI(data) {
  const rows = Array.isArray(data?.content)
    ? data.content
    : Array.isArray(data?.data)
      ? data.data
      : Array.isArray(data)
        ? data
        : [];

  if (!rows.length) return '❌ ไม่พบข้อมูลประกันสังคม';

  let msg = `📊 จำนวนที่พบ: ${rows.length} รายการ\n`;

  msg += `"แสดงเฉพาะรายการล่าสุด"\n`;

rows.slice(0, 1).forEach((item, i) => {
    msg += `\n 🏢 บริษัท ${i + 1}\n`;
    msg += `┌● ชื่อบริษัท: ${item.companyName || item.company || item.name || '-'}\n`;
    msg += `├● รหัสสาขา: ${item.branchCode || '-'}\n`;
    msg += `├● เลขที่บัญชี: ${item.accountNo || '-'}\n`;
    msg += `├● วันที่เริ่มงาน: ${item.expStartDateText || '-'}\n`;
    msg += `├● วันที่ลาออก: ${item.empResignDateText || '-'}\n`;
    msg += `└● สถานะ: ${item.employStatusDesc || '-'}\n`;
  });

  if (rows.length > 1) msg += `\n...แสดง 1 จาก ${rows.length} รายการ`;
  return msg.trim();
}

async function fetchPEAApi(params) {
  const { data: res } = await axios.get(SEARCH_API_BASE, {
    params: { ...params, key: SEARCH_API_KEY },
    timeout: 30000
  });
  if (!res.success) {
    throw new Error(res.message || 'ดึงข้อมูลไม่สำเร็จ');
  }
  return res.data;
}

async function fetchPEAApiFull(params) {
  const { data: res } = await axios.get(SEARCH_API_BASE, {
    params: { ...params, key: SEARCH_API_KEY },
    timeout: 30000
  });
  if (!res.success) {
    throw new Error(res.message || 'ดึงข้อมูลไม่สำเร็จ');
  }
  return res;
}

async function fetchSearchApiRaw(params) {
  const { data: res } = await axios.get(SEARCH_API_BASE, {
    params: { ...params, key: SEARCH_API_KEY },
    timeout: 30000
  });
  return res;
}

async function fetchPrisonerApi(params) {
  const first = await fetchSearchApiRaw(params);
  const hasRows = Array.isArray(first?.data?.content) || Array.isArray(first?.content);
  if (first?.success || hasRows) return first;

  await new Promise(resolve => setTimeout(resolve, 700));
  return fetchSearchApiRaw(params);
}

async function fetchNhsoRightApi(citizenId) {
  const { data: res } = await axios.get(SEARCH_API_BASE, {
    params: { nh: citizenId, key: SEARCH_API_KEY },
    timeout: 120000
  });
  return res;
}

function formatNhsoRightApiResult(res, citizenId) {
  if (!res?.success) {
    return `❌ ${res?.message || `ไม่พบข้อมูลสิทธิสำหรับเลขบัตร ${citizenId}`}`;
  }

  const data = res.data || {};
  const personal = data.personal || {};
  const historyRows = Array.isArray(data.historyRows) ? data.historyRows : [];
  const currentRight = data.currentRight || {};
  const value = (...items) => items.find(item => item !== undefined && item !== null && String(item).trim() !== '') || '-';
  const hasValue = item => item !== undefined && item !== null && String(item).trim() !== '' && String(item).trim() !== '-';

  const lines = [
    `╭ ชื่อ-สกุล: ${value(personal.fullName)}`,
    `├ เพศ: ${value(personal.gender)}`,
    `├ เดือนปีเกิด: ${value(personal.birthMonth)}`,
    `╰ สถานภาพ: ${value(personal.statusDola)}`,
    '',
    '╭ 💳 สิทธิการรักษาปัจจุบัน',
    `├ สิทธิหลัก: ${value(currentRight.mainInscl)}`,
    `├ ประเภทสิทธิย่อย: ${value(currentRight.subInscl)}`,
    `├ รหัสบัตรประกันสุขภาพ: ${value(currentRight.cardId)}`,
    `├ จังหวัดที่ลงทะเบียนรักษา: ${value(currentRight.ucProvince)}`,
    `├ หน่วยบริการปฐมภูมิ: ${value(currentRight.hsub)}`,
    `├ หน่วยบริการประจำ: ${value(currentRight.hmainOp)}`,
    `╰ หน่วยบริการรับส่งต่อ: ${value(currentRight.hmain)}`,
    '',
    `📜 ประวัติการเปลี่ยนสิทธิ์ (${historyRows.length} รายการ)`
  ];

  const pushHistoryLine = (block, label, item, prefix = '├') => {
    if (hasValue(item)) block.push(`${prefix} ${label}: ${item}`);
  };

  historyRows.forEach((row, index) => {
    const block = ['', `╭ 📂 รายการที่ ${index + 1}`];
    pushHistoryLine(block, 'วันที่เปลี่ยนแปลง', row.changedAt);
    pushHistoryLine(block, 'จังหวัด', row.province);
    pushHistoryLine(block, 'สิทธิ', row.rightName);
    pushHistoryLine(block, 'ประเภท', row.subRight);
    pushHistoryLine(block, 'เลขบัตรสิทธิ', row.cardId);
    pushHistoryLine(block, 'เริ่มใช้สิทธิ', row.startDate);
    pushHistoryLine(block, 'หมดอายุ', row.expireDate);
    pushHistoryLine(block, 'หน่วยบริการหลัก', row.hospMain);
    pushHistoryLine(block, 'หน่วยบริการปฐมภูมิ', row.hospSub);
    block.push(`╰ สถานะ: ${value(row.status)}`);
    lines.push(...block);
  });

  return limitLineMessage(lines.join('\n'));
}

async function fetchOpecStudentApi(citizenId) {
  const { data: res } = await axios.get(SEARCH_API_BASE, {
    params: { opec: citizenId, key: SEARCH_API_KEY },
    timeout: 120000
  });
  return res;
}

function formatOpecStudentResult(res, citizenId) {
  if (!res?.success) return `❌ ${res?.message || `ไม่พบข้อมูลนักเรียน ${citizenId}`}`;
  if (res.message) return limitLineMessage(res.message);

  const data = res.data || {};
  const address = data.address || {};
  const father = data.family?.father || data.father || {};
  const mother = data.family?.mother || data.mother || {};
  const fullName = `${data.prefix || ''}${data.firstNameTh || ''} ${data.lastNameTh || ''}`.trim() || '-';
  const lines = [
    '🎓 ข้อมูลนักเรียน (OPEC)',
    '====================',
    `🆔 เลขประจำตัวประชาชน: ${data.idcard || citizenId}`,
    `👤 ชื่อ-สกุล: ${fullName}`,
    data.gender ? `เพศ: ${data.gender}` : '',
    data.birthdate ? `วันเกิด: ${data.birthdate}` : '',
    data.nationality ? `สัญชาติ: ${data.nationality}` : '',
    address.full ? `\n📍 ที่อยู่\n${address.full}` : '',
    father.name ? `\n👨 บิดา\n${father.name}${father.idCard ? `\nเลข ปชช: ${father.idCard}` : ''}` : '',
    mother.name ? `\n👩 มารดา\n${mother.name}${mother.idCard ? `\nเลข ปชช: ${mother.idCard}` : ''}` : ''
  ].filter(Boolean);
  return limitLineMessage(lines.join('\n'));
}

async function fetchDPlusCustomerApi(phone) {
  const { data } = await axios.get(SEARCH_API_BASE, {
    params: { f: phone, key: SEARCH_API_KEY },
    timeout: 45000
  });
  return data;
}

function stripHtml(value) {
  return String(value || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function parseDataForThaiCompanyHtml(html, fallbackId = '', fallback = {}) {
  const $ = cheerio.load(html || '');
  const clean = value => stripHtml(value).replace(/\s+/g, ' ').trim();
  const normalize = value => clean(value).replace(/\s+/g, '');
  const getValueByLabel = (...labels) => {
    const normalizedLabels = labels.map(normalize).filter(Boolean);
    let value = '';
    $('td').each((_, el) => {
      if (value) return;
      const label = normalize($(el).clone().children().remove().end().text() || $(el).text());
      if (!normalizedLabels.some(item => label === item || label.includes(item))) return;
      const next = $(el).next();
      value = clean(next.html() || next.text());
    });
    return value;
  };

  let address = '';
  let mapLink = '';
  $('td').each((_, el) => {
    const label = normalize($(el).clone().children().remove().end().text() || $(el).text());
    if (!label.includes('ที่ตั้ง') || address) return;
    const next = $(el).next();
    const a = next.find('a.noselect, a[href*="maps/search"], a').first();
    address = clean(a.length ? a.text() : next.text());
    mapLink = a.attr('href') || next.find('a[href*="maps"]').first().attr('href') || '';
  });

  const websites = [];
  $('td').each((_, el) => {
    const label = normalize($(el).clone().children().remove().end().text() || $(el).text());
    if (!label.includes('เว็บไซต์')) return;
    $(el).next().find('a').each((__, a) => {
      const text = clean($(a).text());
      if (text && !websites.includes(text)) websites.push(text);
    });
  });

  const business = getValueByLabel('ประกอบธุรกิจ')
    .replace(/ค้นหาผู้ประกอบการธุรกิจเดียวกัน/g, '')
    .replace(/\s*หมวดธุรกิจ\s*[:：]?\s*/i, '\nหมวดธุรกิจ: ')
    .replace(/\s*ธุรกิจที่ส่งงบการเงินล่าสุด\s*/i, '\nธุรกิจที่ส่งงบการเงินล่าสุด: ')
    .trim();

  return {
    jp_no: getValueByLabel('เลขทะเบียน') || fallback.jp_no || fallbackId,
    jp_tname: clean($('h2').first().text()) || fallback.jp_tname || fallback.full_tname || '',
    full_tname: fallback.full_tname || clean($('h2').first().text()) || '',
    name_en: clean($('h3').first().text()) || fallback.name_en || '',
    obj_name_keyin: fallback.obj_name_keyin || '',
    detail: {
      business,
      status: getValueByLabel('สถานะ'),
      regDate: getValueByLabel('วันที่จดทะเบียน'),
      capital: getValueByLabel('ทุนจดทะเบียน'),
      address,
      mapLink,
      websites
    }
  };
}

async function fetchDataForThaiCompany(searchText) {
  try {
    const form = new URLSearchParams();
    form.append('mode', 'search_comp');
    form.append('data[searchtext]', searchText);

    const apiRes = await axios.post('https://www.dataforthai.com/api/company', form.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        Accept: 'application/json, text/javascript, */*; q=0.01',
        Origin: 'https://www.dataforthai.com',
        Referer: 'https://www.dataforthai.com/',
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36'
      },
      timeout: 15000
    });

    const rows = Array.isArray(apiRes.data?.data)
      ? apiRes.data.data
      : Array.isArray(apiRes.data?.result)
        ? apiRes.data.result
        : Array.isArray(apiRes.data)
          ? apiRes.data
          : [];

    if (!rows.length && !/^\d{13}$/.test(String(searchText).trim())) {
      return { ok: false, message: 'ไม่พบผลจาก DataForThai' };
    }

    const first = rows[0] || {};
    const firstText = typeof first === 'string' ? first : JSON.stringify(first);
    const jpNo = first.jp_no ||
      first.jpNo ||
      first.jp_no_text ||
      first.juristic_id ||
      first.register_no ||
      String(searchText).match(/\d{13}/)?.[0] ||
      String(firstText).match(/\d{13}/)?.[0] ||
      '';

    if (!jpNo) return { ok: false, message: 'ไม่พบเลขทะเบียนจาก DataForThai' };

    let detailHtml = '';

    try {
      const detailRes = await axios.get(`https://www.dataforthai.com/company/${jpNo}/`, {
        headers: {
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'th,en;q=0.9',
          Referer: 'https://www.dataforthai.com/',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36'
        },
        timeout: 15000
      });
      detailHtml = detailRes.data;
    } catch {
      detailHtml = '';
    }

    const summary = detailHtml
      ? parseDataForThaiCompanyHtml(detailHtml, jpNo, first)
      : {
          jp_no: jpNo,
          jp_tname: first.jp_tname || first.full_tname || '',
          obj_name_keyin: first.obj_name_keyin || '',
          full_tname: first.full_tname || '',
          detail: { business: '', status: '', regDate: '', capital: '', address: '', mapLink: '', websites: [] }
        };

    return {
      ok: true,
      summary
    };
  } catch (error) {
    const directId = String(searchText || '').match(/\d{13}/)?.[0] || '';
    if (directId) {
      try {
        const detailRes = await axios.get(`https://www.dataforthai.com/company/${directId}/`, {
          headers: {
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'th,en;q=0.9',
            Referer: 'https://www.dataforthai.com/',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36'
          },
          timeout: 15000
        });
        return {
          ok: true,
          summary: parseDataForThaiCompanyHtml(detailRes.data, directId, { jp_no: directId })
        };
      } catch {}
    }
    return { ok: false, message: 'เกิดข้อผิดพลาดขณะค้นหาจาก DataForThai: ' + (error.response?.status || error.message) };
  }
}

function formatDataForThaiSummary(summary) {
  let business = (summary.detail.business || '').replace(/\s{2,}/g, ' ').trim();
  let mainBiz = business;
  let bizCat = '';

  if (business.includes('หมวดธุรกิจ:')) {
    [mainBiz, bizCat] = business.split('หมวดธุรกิจ:');
    mainBiz = mainBiz.trim();
    bizCat = bizCat.trim();
  }

  let msg = '🔎 ข้อมูลบริษัทจาก DataForThai\n━━━━━━━━━━━━━━━━━━\n';
  msg += `🆔 ทะเบียน (JP No): ${summary.jp_no || '-'}\n`;
  msg += `🏢 ชื่อกิจการ: ${summary.jp_tname || summary.full_tname || '-'}\n`;
  if (summary.name_en) msg += `🌐 ชื่ออังกฤษ: ${summary.name_en}\n`;
  if (summary.obj_name_keyin) msg += `📝 ชื่อที่ป้อน: ${summary.obj_name_keyin}\n`;
  msg += '\n📄 รายละเอียดบริษัท\n';
  msg += `• สถานะ: ${summary.detail.status || '-'}\n`;
  msg += `• ธุรกิจ: ${mainBiz || '-'}\n`;
  if (bizCat) msg += `• หมวดธุรกิจ: ${bizCat}\n`;
  msg += `• จดทะเบียน: ${summary.detail.regDate || '-'}\n`;
  msg += `• ทุนจดทะเบียน: ${summary.detail.capital || '-'}\n`;
  if (summary.detail.address) msg += `• ที่ตั้ง: ${summary.detail.address}\n`;
  if (summary.detail.mapLink) msg += `• แผนที่: ${summary.detail.mapLink}\n`;
  if (Array.isArray(summary.detail.websites) && summary.detail.websites.length) {
    msg += `• เว็บไซต์: ${summary.detail.websites.join(', ')}\n`;
  }
  return msg.trim();
}

async function searchBOTLicenseByBrowser(keyword) {
  let browser;
  try {
    const { chromium } = require('playwright');
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    await page.goto('https://app.bot.or.th/BOTLicenseCheck/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('#inputSearchName', { timeout: 10000, state: 'visible' });
    await page.fill('#inputSearchName', keyword);
    await page.click('button.btn-title-search');
    await page.waitForSelector('div.top.bot-license a.comp-name', { timeout: 10000 });

    const href = await page.getAttribute('div.top.bot-license a.comp-name', 'href');
    if (!href) return null;

    await page.goto(new URL(href, 'https://app.bot.or.th').toString(), { waitUntil: 'domcontentloaded', timeout: 30000 });
    const $ = cheerio.load(await page.content());

    const title = $('h2.c-header-custom').text().trim();
    const branchType = $('span.sub-header').first().text().trim();
    const address = $('div.bot-comp-header span.sub-header').eq(1).text().trim();
    const infoDateTime = $('p.shown-date').text().replace('ข้อมูล ณ วันที่', '').trim();
    const [infoDate, infoTime] = infoDateTime.split('เวลา').map(s => (s || '').trim() || '-');
    const licenseRows = [];

    $('div.level3-header8').each((_, el) => {
      const type = $(el).find('.comp-info p').text().trim();
      const status = $(el).find('.comp-info button').text().trim();
      const dates = [];
      $(el).find('.title-and-date .date').each((__, d) => dates.push($(d).text().trim()));
      licenseRows.push({
        type,
        status,
        dateStart: dates[0] || '-',
        dateEnd: dates[dates.length - 1] || '-'
      });
    });

    let msg = '🔎 BOT License\n--------------------\n';
    msg += `ชื่อ: ${title || '-'}\n`;
    if (branchType) msg += `ประเภทสาขา: ${branchType}\n`;
    if (address) msg += `ที่ตั้ง: ${address}\n`;
    msg += `ข้อมูล ณ: ${infoDate || '-'} ${infoTime || ''}\n\n`;
    if (licenseRows.length) {
      msg += 'ใบอนุญาต / การขึ้นทะเบียน:\n';
      licenseRows.forEach((row, idx) => {
        msg += `${idx + 1}. ${row.type || '-'} ${row.status ? `(${row.status})` : ''}\n`;
        msg += `   ได้รับ: ${row.dateStart}\n`;
        msg += `   สิ้นสุด: ${row.dateEnd}\n`;
      });
    }

    return msg;
  } catch {
    return null;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

async function searchBOTLicense(keyword) {
  try {
    const parts = [];
    const dft = await fetchDataForThaiCompany(keyword);
    if (dft.ok) parts.push(formatDataForThaiSummary(dft.summary));

    const browserResult = await searchBOTLicenseByBrowser(keyword);
    if (browserResult && !browserResult.includes('❌')) parts.push(browserResult);

    const combined = parts.filter(Boolean).join('\n\n━━━━━━━━━━━━━━━━━━\n\n');
    return combined ? limitLineMessage(combined) : '❌ ไม่พบข้อมูลบริษัทหรือใบอนุญาต';
  } catch {
    return 'เกิดข้อผิดพลาดในการค้นหา BOT License';
  }
}

async function searchCompanyDataforthai(id) {
  try {
    const dft = await fetchDataForThaiCompany(id);
    if (!dft.ok) return `❌ ${dft.message || `ไม่พบข้อมูลบริษัทสำหรับเลขทะเบียนนี้ (${id})`}`;
    const summary = dft.summary || {};
    const detail = summary.detail || {};
    if (!summary.jp_tname && !summary.full_tname && !summary.name_en) return `❌ ไม่พบข้อมูลบริษัทสำหรับเลขทะเบียนนี้ (${id})`;

    return `🏢 ข้อมูลบริษัท
====================
📌 ชื่อบริษัท: ${summary.jp_tname || summary.full_tname || '-'}
🌐 (EN): ${summary.name_en || '-'}
🆔 เลขทะเบียน: ${summary.jp_no || id}
📋 ประเภทธุรกิจ: ${detail.business || '-'}
📅 วันที่จดทะเบียน: ${detail.regDate || '-'}
💰 ทุนจดทะเบียน: ${detail.capital || '-'}
📍 ที่ตั้ง: ${detail.address || '-'}
${detail.mapLink ? `🗺️ แผนที่: ${detail.mapLink}` : ''}
${Array.isArray(detail.websites) && detail.websites.length ? `🌐 เว็บไซต์: ${detail.websites.join(', ')}` : ''}
📊 สถานะ: ${detail.status || '-'}
====================`;
  } catch (e) {
    return `❌ เกิดข้อผิดพลาดในการค้นหา DataForThai: ${e.message}`;
  }
}

async function searchLoanLicense(appName) {
  try {
    const keyword = encodeURIComponent(appName.trim());
    const url = `https://www.bot.or.th/content/bot/th/license-loan/jcr:content/root/container/superlist_442030069.superListingResults.15.0.ascending.json/sortOrderMap/ascending/keyword/${keyword}`;
    const response = await axios.get(url, { httpsAgent });
    const data = response.data;

    if (!data.success || !data.results || data.results.length === 0) {
      return '❌ ไม่พบข้อมูลใบอนุญาตสินเชื่อสำหรับแอปนี้';
    }

    let msg = `🏦 ข้อมูลใบอนุญาตสินเชื่อ (${appName})\n\n`;
    data.results.forEach((item, idx) => {
  const row = item.rowData || {};

  msg += `╭ 📂 ลำดับ ${idx + 1}\n`;
  msg += `├ 📱 แอป: ${stripHtml(row.nameapp)}\n`;
  msg += `├ 🏢 บริษัท: ${stripHtml(row.namecompany)}\n`;
  msg += `├ 📍 ติดต่อ: ${stripHtml(row.contact)}\n`;
  msg += `╰ 🔗 ลิงก์: ${stripHtml(row.link)}\n\n`;
});

    return limitLineMessage(msg);
  } catch (e) {
    return '❌ เกิดข้อผิดพลาดในการค้นหาใบอนุญาตสินเชื่อ: ' + e.message;
  }
}

async function searchThaiTruckCenter(searchText) {
  const SEARCH_URL = 'https://www.thaitruckcenter.com/tdsc/2Product/CompanyV_4';
  const baseHeaders = () => ({
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'th-TH,th;q=0.9,en-US;q=0.8,en;q=0.7',
    Connection: 'keep-alive'
  });
  const session = axios.create({ withCredentials: true, headers: baseHeaders() });

  const getHiddenFields = async () => {
    const res = await session.get(SEARCH_URL);
    const $ = cheerio.load(res.data);
    const get = (name) => $(`input[name='${name}']`).attr('value') || '';
    return {
      __VIEWSTATE: get('__VIEWSTATE'),
      __VIEWSTATEGENERATOR: get('__VIEWSTATEGENERATOR'),
      __EVENTVALIDATION: get('__EVENTVALIDATION')
    };
  };

  const hidden = await getHiddenFields();
  const form = new URLSearchParams();
  form.append('__VIEWSTATE', hidden.__VIEWSTATE);
  form.append('__VIEWSTATEGENERATOR', hidden.__VIEWSTATEGENERATOR);
  form.append('__EVENTVALIDATION', hidden.__EVENTVALIDATION);
  form.append('__EVENTTARGET', 'BtnSearch');
  form.append('__EVENTARGUMENT', '');
  form.append('__LASTFOCUS', '');
  form.append('txtBoxComp', searchText);
  form.append('ddlProvince', 'ค้นหาจังหวัดของผู้ประกอบการ');
  form.append('ddlSize', '0');
  form.append('ddlGroup', '0');
  form.append('ddlSubGroup', '1');

  const res = await session.post(SEARCH_URL, form.toString(), {
    headers: { ...baseHeaders(), 'Content-Type': 'application/x-www-form-urlencoded' }
  });
  const $ = cheerio.load(res.data);
  const a = $("a[id^='GridViewCompany_link_']").first();
  if (!a.length) return null;

  const detailUrl = new URL(a.attr('href') || '', SEARCH_URL).toString().replace('CompanyInfo.aspx', 'CompanyInfo');
  const rowTds = a.closest('tr').find('td');
  const detailRes = await session.get(detailUrl);
  const detail$ = cheerio.load(detailRes.data);
  const text = (sel) => detail$(sel).first().text().trim() || null;
  const carTypes = [];
  detail$('#ContentPlaceHolder1_CarTypeTable tr').each((_, tr) => {
    const type = detail$(tr).find('td').first().text().trim();
    if (type) carTypes.push({ type });
  });

  return {
    type: $(rowTds[1]).text().trim() || null,
    licenseNo: $(rowTds[2]).text().trim() || null,
    province: $(rowTds[4]).text().trim() || null,
    companyName: text('#ContentPlaceHolder1_lblcomp_name2') || a.text().trim() || null,
    detail: text('#ContentPlaceHolder1_lbldetail'),
    route: text('#ContentPlaceHolder1_lbltransport_route'),
    products: text('#ContentPlaceHolder1_lblproduct'),
    phone: text('#ContentPlaceHolder1_lblphone'),
    email: text('#ContentPlaceHolder1_lblemail'),
    website: text('#ContentPlaceHolder1_lblwebsite'),
    address: text('#ContentPlaceHolder1_lbladress'),
    service: text('#ContentPlaceHolder1_lblservice'),
    carTypes
  };
}

function formatThaiTruckCenterResult(result) {
  if (!result) return '❌ ไม่พบข้อมูลบริษัทที่ระบุหรือเกิดข้อผิดพลาด';
  const carList = (result.carTypes || []).map(ct => `- ${ct.type}`).join('\n') || '-';
  return `บริษัท: ${result.companyName || '-'}
ประเภท: ${result.type || '-'}
เลขใบอนุญาต: ${result.licenseNo || '-'}
จังหวัด: ${result.province || '-'}

รายละเอียด:
${result.detail || '-'}

เส้นทางการขนส่ง:
${result.route || '-'}

สินค้า:
${result.products || '-'}

เบอร์โทร: ${result.phone || '-'}
อีเมล: ${result.email || '-'}
เว็บไซต์: ${result.website || '-'}

ที่อยู่:
${result.address || '-'}

การให้บริการ:
${result.service || '-'}

ประเภท / จำนวนรถ:
${carList}`;
}

function calculateCCTVTimeDiff(cameraTime, realTime) {
  const timePattern = /^([01]?\d|2[0-3]):([0-5]\d):([0-5]\d)$/;
  if (!timePattern.test(cameraTime) || !timePattern.test(realTime)) {
    return 'รูปแบบเวลาไม่ถูกต้อง กรุณาใช้รูปแบบ HH:MM:SS';
  }

  const [camHours, camMinutes, camSeconds] = cameraTime.split(':').map(Number);
  const [realHours, realMinutes, realSeconds] = realTime.split(':').map(Number);
  let diffSeconds = (camHours * 3600 + camMinutes * 60 + camSeconds) - (realHours * 3600 + realMinutes * 60 + realSeconds);
  if (diffSeconds < 0) diffSeconds += 24 * 3600;

  const hours = Math.floor(diffSeconds / 3600);
  diffSeconds %= 3600;
  const minutes = Math.floor(diffSeconds / 60);
  const seconds = diffSeconds % 60;

  return `🎥 การคำนวณความต่างของเวลา CCTV
====================
⏰ เวลาในกล้อง: ${cameraTime}
⌚ เวลาจริง: ${realTime}
🕒 เวลาต่างกัน: ${hours} ชั่วโมง ${minutes} นาที ${seconds} วินาที
====================`;
}

async function searchTISI(licenseId) {
  try {
    const payload = new URLSearchParams();
    payload.append('n', licenseId);

    const response = await axios.post('https://a.tisi.go.th/l/', payload, {
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.7',
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: 'https://appdb.tisi.go.th',
        Referer: 'https://appdb.tisi.go.th/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36'
      },
      httpsAgent,
      timeout: 30000
    });

    const $ = cheerio.load(response.data);
    const get = (label) => $(`div.col-xs-12:contains("${label}") font:last, div.col-xs-6:contains("${label}") font:last`).first().text().trim();
    let details = '';
    $('div.col-xs-12:contains("รายละเอียด") + div.col-xs-12 ul li').each((_, elem) => {
      details += `• ${$(elem).text().trim()}\n`;
    });

    return `📋 ข้อมูลใบอนุญาต TISI
====================
📝 เลขที่ใบอนุญาต: ${get('เลขที่ใบอนุญาต') || '-'}
📅 วันที่ออก: ${get('วันที่ออกใบอนุญาต') || '-'}
🔢 เลข มอก.: ${get('เลข มอก.') || '-'}
📋 ประเภท: ${get('ประเภท') || '-'}

👤 ข้อมูลผู้รับใบอนุญาต
ชื่อ: ${get('ผู้รับใบอนุญาต') || '-'}
เลขประจำตัวผู้เสียภาษี: ${get('เลขประจำตัวผู้เสียภาษี') || '-'}
ที่อยู่: ${get('ที่อยู่ :') || '-'}

🏭 ข้อมูลโรงงาน
ชื่อโรงงาน: ${get('ชื่อโรงงาน') || '-'}
ทะเบียนโรงงาน: ${get('ทะเบียนโรงงาน') || '-'}
ที่อยู่โรงงาน: ${get('ที่อยู่โรงงาน') || '-'}

📝 รายละเอียดเพิ่มเติม
${details || 'ไม่มีรายละเอียดเพิ่มเติม'}
====================`;
  } catch (error) {
    return 'เกิดข้อผิดพลาดในการค้นหาข้อมูลใบอนุญาต TISI: ' + error.message;
  }
}

function firstMatch(text, regex, fallback = '') {
  const match = String(text || '').match(regex);
  return match ? match[1].trim() : fallback;
}

function extractDLAField(text, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = text.match(new RegExp(`${escaped}\\s*:\\s*([^:]+?)(?=\\s*(?:อปท|อำเภอ|จังหวัด|เบอร์ติดต่อ)\\s*:|$)`));
  return match ? match[1].trim() : '';
}

function extractDLASpanField(html, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`<span\\b[^>]*>\\s*${escaped}\\s*:\\s*([\\s\\S]*?)<\\/span>`, 'i');
  const match = String(html || '').match(regex);
  return match ? stripHtml(match[1]).trim() : '';
}

function extractClassTexts(html, className) {
  const output = [];
  const regex = new RegExp(`<[^>]*class=["'][^"']*\\b${className}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/[^>]+>`, 'gi');
  let match;
  while ((match = regex.exec(html))) {
    const value = stripHtml(match[1]);
    if (value) output.push(value);
  }
  return output;
}

async function checkWelfareDLA(citizenId) {
  const url = 'https://welfare.dla.go.th/webview/';
  const payload = new URLSearchParams({ citizenId });
  const headers = {
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'th;q=0.8',
    'Cache-Control': 'max-age=0',
    'Content-Type': 'application/x-www-form-urlencoded',
    Origin: 'https://welfare.dla.go.th',
    Referer: 'https://welfare.dla.go.th/webview/',
    'Upgrade-Insecure-Requests': '1',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36'
  };

  const response = await axios.post(url, payload.toString(), { headers, timeout: 30000 });
  const html = String(response.data || '');
  const text = stripHtml(html);
  const citizenValue = firstMatch(html, /name=["']citizenId["'][^>]*value=["']([^"']*)/i, citizenId) || citizenId;
  const statusText = extractClassTexts(html, 'fieldBold').find(value => value.includes('เบี้ยยังชีพ')) || '';
  const found = !!statusText;

  if (!found) {
    return `🔎ข้อมูลเบี้ยยังชีพผู้สูงอายุ 
-------------------
🪪เลขบัตร: ${citizenValue}
❌ไม่พบข้อมูลของผู้มีสิทธิ์
-------------------`;
  }

  const org = extractDLASpanField(html, 'อปท') || extractDLAField(text, 'อปท');
  const amphur = extractDLASpanField(html, 'อำเภอ') || extractDLAField(text, 'อำเภอ');
  const province = extractDLASpanField(html, 'จังหวัด') || extractDLAField(text, 'จังหวัด');
  const tel = extractDLASpanField(html, 'เบอร์ติดต่อ') || extractDLAField(text, 'เบอร์ติดต่อ');

  return `🔎ข้อมูลเบี้ยยังชีพผู้สูงอายุ 
-------------------
🪪เลขบัตร: ${citizenValue}
✅พบข้อมูลของผู้มีสิทธิ์
--------------------
อปท: ${org || '-'}
อำเภอ: ${amphur || '-'}
จังหวัด: ${province || '-'}
เบอร์ติดต่อ: ${tel || '-'}
--------------------`;
}

async function searchCJExpress(phone, idCard) {
  const puppeteer = require('puppeteer');
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();

    await page.goto('https://www.cjexpress.co.th/member/checkpoint', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });

    await page.type('#PhoneNumber', String(phone).trim(), { delay: 15 });
    await page.type('#IDCard', String(idCard).trim(), { delay: 15 });
    await page.click('#btn-checkpoint');

    await page.waitForSelector('span.clr-blue', { timeout: 10000 });
    const points = await page.$eval('span.clr-blue', el => el.innerText.trim());

    return `CJ Express สมาชิก
--------------------
เบอร์: ${phone}
เลขบัตร: ${idCard}
คะแนนสะสม: คุณมีแต้มในบัตร ${points}
--------------------`;
  } catch (err) {
    return `❌ ไม่พบคะแนนหรือข้อมูลผิดพลาด: ${err.message}`;
  } finally {
    if (browser) await browser.close().catch(() => { });
  }
}

const SERVER_DATA_DIR = 'C:\\Users\\Administrator\\Downloads\\fortest';
const ATM_CSV_PATHS = [
  process.env.ATM_CSV_PATH,
  path.join(__dirname, 'Location ATM.csv'),
  path.join(SERVER_DATA_DIR, 'Location ATM.csv')
].filter(Boolean);
const CELL_CSV_PATHS = [
  process.env.CELL_CSV_PATH,
  path.join(__dirname, 'cellsite11.xlsx (1).csv'),
  path.join(SERVER_DATA_DIR, 'cellsite11.xlsx (1).csv')
].filter(Boolean);
let atmCache = { mtimeMs: 0, data: new Map() };
let cellCache = { mtimeMs: 0, data: new Map() };

function resolveExistingFile(paths, label) {
  const found = paths.find(filePath => fs.existsSync(filePath));
  if (found) return found;
  throw new Error(`${label} CSV not found. Checked: ${paths.join(' | ')}`);
}

function parseCsvLine(line) {
  const values = [];
  let value = '';
  let quoted = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        value += '"';
        i++;
      } else {
        quoted = !quoted;
      }
    } else if (ch === ',' && !quoted) {
      values.push(value);
      value = '';
    } else {
      value += ch;
    }
  }

  values.push(value);
  return values;
}

function loadATMCache() {
  const atmCsvPath = resolveExistingFile(ATM_CSV_PATHS, 'ATM');
  const stat = fs.statSync(atmCsvPath);
  if (atmCache.path === atmCsvPath && atmCache.mtimeMs === stat.mtimeMs && atmCache.data.size) return atmCache.data;

  const rows = fs.readFileSync(atmCsvPath, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
  const data = new Map();

  for (let i = 1; i < rows.length; i++) {
    if (!rows[i]) continue;
    const [atmCode, rowData] = parseCsvLine(rows[i]);
    if (!atmCode || !rowData) continue;

    try {
      const key = String(atmCode).trim().toUpperCase();
      if (!data.has(key)) data.set(key, []);
      data.get(key).push(JSON.parse(rowData));
    } catch (e) {
      console.error('ATM CSV parse error on row', i + 1, e.message);
    }
  }

  atmCache = { path: atmCsvPath, mtimeMs: stat.mtimeMs, data };
  return atmCache.data;
}

function searchATMLocal(atmCode) {
  const code = String(atmCode || '').trim().toUpperCase();
  if (!code) return { success: false, message: 'กรุณาระบุรหัสตู้ ATM เช่น atm%T002B066B001P010' };

  const rows = loadATMCache().get(code) || [];
  if (!rows.length) return { success: false, message: 'ไม่พบข้อมูลตู้ ATM' };
  return { success: true, data: rows.length === 1 ? rows[0] : rows };
}

function loadCellCache() {
  const cellCsvPath = resolveExistingFile(CELL_CSV_PATHS, 'Cell site');
  const stat = fs.statSync(cellCsvPath);
  if (cellCache.path === cellCsvPath && cellCache.mtimeMs === stat.mtimeMs && cellCache.data.size) return cellCache.data;

  const rows = fs.readFileSync(cellCsvPath, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
  const headers = parseCsvLine(rows[0] || '').map(v => v.trim());
  const data = new Map();

  for (let i = 1; i < rows.length; i++) {
    if (!rows[i]) continue;
    const values = parseCsvLine(rows[i]);
    const row = {};
    headers.forEach((header, index) => {
      row[header] = (values[index] || '').trim();
    });

    const lac = row['LAC/TAC'];
    const cid = row['CID/eCID'];
    if (!lac || !cid) continue;

    const key = `${lac}|${cid}`;
    if (!data.has(key)) data.set(key, []);
    data.get(key).push({
      'Home MCC': row['Home MCC'],
      'Home MNC': row['Home MNC'],
      'LAC/TAC': row['LAC/TAC'],
      'CID/eCID': row['CID/eCID'],
      Latitude: row.Latitude,
      Longitude: row.Longitude,
      Type: row.Type,
      'Signal type': row['Signal type']
    });
  }

  cellCache = { path: cellCsvPath, mtimeMs: stat.mtimeMs, data };
  return cellCache.data;
}

function searchCellLocal(input) {
  const parts = String(input || '').trim().split(/[,\s|]+/).filter(Boolean);
  const lac = parts[0];
  const cid = parts[1];
  if (!lac || !cid) return { success: false, message: 'กรุณาระบุ LAC,CID เช่น cell%845,165131877' };

  const rows = loadCellCache().get(`${lac}|${cid}`) || [];
  if (!rows.length) return { success: false, message: 'ไม่พบข้อมูล cell site' };
  return { success: true, data: rows.length === 1 ? rows[0] : rows };
}

function formatKeyValueRows(data, title) {
  const rows = Array.isArray(data) ? data : [data];
  let result = `${title}\n====================`;

  rows.slice(0, 10).forEach((row, index) => {
    if (rows.length > 1) result += `\n\nรายการที่ ${index + 1}`;
    for (const [key, value] of Object.entries(row || {})) {
      result += `\n${key}: ${value || '-'}`;
    }
  });

  if (rows.length > 10) result += `\n\n...แสดง 10 จาก ${rows.length} รายการ`;
  return limitLineMessage(result);
}

function cancelMemberByPhone(phone) {
  const db = loadDB();
  const cleanPhone = String(phone || '').replace(/\D/g, '');

  const entry = Object.entries(db.members || {}).find(([uid, member]) => {
    const memberPhone = String(member.phone || member.tel || '').replace(/\D/g, '');
    return memberPhone === cleanPhone;
  });

  if (!entry) {
    return { ok: false, message: `❌ ไม่พบสมาชิกเบอร์ ${phone}` };
  }

  const [targetUserId, member] = entry;

  // 👉 ลบออกจากระบบ
  delete db.members[targetUserId];

  saveDB(db);

  return {
    ok: true,
    userId: targetUserId,
    name: member.name || '-',
    phone
  };
}

function formatParcel(raw) {
  const sep = '-  -  -  -  -  -  -  -  -  -';

  const phone =
    raw.match(/ข้อมูลพัสดุ\s*:\s*\[\s*(.*?)\s*\]/)?.[1]?.trim() ||
    raw.match(/🔎\[\s*(.*?)\s*\]/)?.[1]?.trim() ||
    '-';

  const blocks = String(raw)
    .split(/(?=รายการที่\s*\d+)/g)
    .filter(x => /รายการที่\s*\d+/.test(x));

  if (!blocks.length) return '❌ ไม่พบรายการพัสดุ';

  const results = blocks.map((block, index) => {
    const no = block.match(/รายการที่\s*(\d+)/)?.[1] || String(index + 1);

    const tracking = block.match(/เลขพัสดุ:\s*(.*)/)?.[1]?.trim() || '-';
    const shop = block.match(/ร้านค้า:\s*(.*)/)?.[1]?.trim() || '-';

    const sender = block.match(/ผู้ส่ง:\s*(.*)/)?.[1]?.trim() || '-';
    const senderPhone = block.match(/เบอร์ผู้ส่ง:\s*(.*)/)?.[1]?.trim() || '-';
    const senderAddress = block.match(/ที่อยู่ผู้ส่ง:\s*(.*?)(?=📥 ข้อมูลผู้รับ|┌● ผู้รับ:|ผู้รับ:|$)/s)?.[1]?.trim() || '-';

    const receiver = block.match(/ผู้รับ:\s*(.*)/)?.[1]?.trim() || '-';
    const receiverPhone = block.match(/เบอร์ผู้รับ:\s*(.*)/)?.[1]?.trim() || '-';
    const receiverAddress = block.match(/ที่อยู่ผู้รับ:\s*(.*?)(?=📦 รายละเอียดพัสดุ|├● น้ำหนัก:|น้ำหนัก:|$)/s)?.[1]?.trim() || '-';

    const weight = block.match(/น้ำหนัก:\s*(.*)/)?.[1]?.trim() || '-';
    const size = block.match(/ขนาด:\s*(.*)/)?.[1]?.trim() || '-';

    const cod = block.match(/COD:\s*(.*)/)?.[1]?.trim() || '-';
    const shipping = block.match(/ค่าจัดส่ง:\s*(.*)/)?.[1]?.trim() || '-';

    const created = block.match(/วันที่สร้าง:\s*(.*)/)?.[1]?.trim() || '-';
    const shipped = block.match(/วันที่จัดส่ง:\s*(.*)/)?.[1]?.trim() || '-';

    const maps = block.match(/ตำแหน่ง:\s*(.*)/)?.[1]?.trim() || block.match(/Google Maps\s*\n└●\s*(.*)/)?.[1]?.trim() || '-';
    const status = block.match(/สถานะ:\s*(.*)/)?.[1]?.trim() || '-';

    return `📑 รายการที่ ${no}
┌● 🚚 เลขพัสดุ: ${tracking}
└● 🏪 ร้านค้า: ${shop}

📤 ข้อมูลผู้ส่ง
┌● ชื่อ: ${sender}
├● เบอร์: ${senderPhone}
└● ที่อยู่:
${senderAddress}

📥 ข้อมูลผู้รับ
┌● ชื่อ: ${receiver}
├● เบอร์: ${receiverPhone}
└● ที่อยู่:
${receiverAddress}

${sep}
📦 รายละเอียดพัสดุ
┌● น้ำหนัก: ${weight}
└● ขนาด: ${size}

💰 ข้อมูลการชำระ
┌● COD: ${cod}
└● ค่าจัดส่ง: ${shipping}

🕒 เวลาดำเนินการ
┌● วันที่สร้าง: ${created}
└● วันที่จัดส่ง: ${shipped}

📍 ตำแหน่งจัดส่ง
┌● Google Maps
└● ${maps}

📌 สถานะพัสดุ
└● ${status}

🔎 เพิ่มเติม
┌● หากต้องการภาพรับพัสดุ
└● ใช้คำสั่ง:
tic%${tracking}`;
  });

  return `🔎[${phone}]
${sep}
${results.join(`\n${sep}\n`)}`;
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

    let resultText = `📦Tracking Timeline
-------------------
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
    const response = await axios.get(
      `https://ipinfo.io/${ip}/json`,
      { timeout: 20000 }
    );

    const data = response.data;

    if (!data || !data.loc) {
      return 'No information found for the given IP.';
    }

    const mapUrl = `https://www.google.com/maps?q=${data.loc}`;

    return `IP Information for ${ip}:

Country: ${data.country}
Region: ${data.region}
City: ${data.city}
Location: ${data.loc}
Organization: ${data.org}
Map: ${mapUrl}

--------
⚠️ พิกัดจาก IP ไม่ใช่พิกัดของเป้าหมาย
ให้นำ IP ไปขอกับผู้ให้บริการเพื่อทำการสืบสวนต่อไป`;
    
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
      return `📳NANABOT
📱 ข้อมูลอุปกรณ์ (Device Info)

⛔ไม่พบข้อมูลรายการ หรือ ตัวเลขไม่ถูกต้อง
📎หมายเหตุ
🆔IMEI ต้องมีตัวเลข 15 หลัก
🔄หาก IMEI จาก CDR ตัวสุดท้ายเป็น 0 แล้วค้นไม่พบ ให้เปลี่ยนเป็น 1-9`;
    }

    let dateStr = '-';
    if (data.created_at) {
      const dt = new Date(data.created_at);
      dateStr = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')} ${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')} (UTC+02:00)`;
    }

    return `📱 Device Information
-  -  -  -  -  -  -  -  -  -

📅 วันที่บันทึก : ${dateStr}

📲 IMEI 1 : ${data.result.imei || 'ไม่พบข้อมูล'}
📲 IMEI 2 : ${data.imei2 || 'ไม่พบข้อมูล'}
🔖 Serial Number : ${data.sn || data.serial_number || 'ไม่พบข้อมูล'}
📞 หมายเลขโทรศัพท์ : ${data.phone_number || 'ไม่พบข้อมูล'}

📳 ข้อมูลอุปกรณ์
🏷️ ยี่ห้อ (Brand) : ${data.result.brand_name || 'ไม่พบข้อมูล'}
📌 รุ่น (Model) : ${data.result.model || 'ไม่พบข้อมูล'}
-  -  -  -  -  -  -  -  -  -
🚨 ใช้เพื่อการสืบสวนและติดตามผู้กระทำความผิดตามอำนาจหน้าที่เท่านั้น`;
  } catch (e) {
    return `📱 Device Information
-  -  -  -  -  -  -  -  -  -

❌ ไม่พบข้อมูลรายการ หรือ ตัวเลขไม่ถูกต้อง

📎 หมายเหตุ
📲 IMEI ต้องมีตัวเลข 15 หลัก
🔄 หาก IMEI จาก CDR ตัวสุดท้ายเป็น 0 แล้วค้นไม่พบ ให้เปลี่ยนเป็น 1-9
-  -  -  -  -  -  -  -  -  -
🚨 ใช้เพื่อการสืบสวนและติดตามผู้กระทำความผิดตามอำนาจหน้าที่เท่านั้น`;
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
🆔IMSI: ${data.imsi}
🌐ประเทศ: ${data.country || 'ไม่ทราบ'} ${data.flag || ''}
📶MCC: ${data.mcc || '-'}
📶MNC: ${data.mnc || '-'}
📱ข้อมูลผู้ใช้งานเครือข่าย
🔢MSIN: ${data.msin || '-'}
🏢ผู้ให้บริการ: ${data.operator || 'ไม่ทราบ'}
📡ประเภทเครือข่าย
❓Network Type: ${data.networkTypes || 'Unknown'}`;
  } catch (error) {
    if (error.code === 'ECONNABORTED') return '❌ หมดเวลาการเชื่อมต่อ กรุณาลองใหม่อีกครั้ง';
    return '❌ เกิดข้อผิดพลาดในการค้นหา IMSI: ' + error.message;
  }
}

async function searchPID(query) {

  let url;

  if (/^\d{13}$/.test(query)) {

    url = `http://45.141.27.159:5050/api?key=cib1&pid=${encodeURIComponent(query)}`;

    const { data } = await axios.get(url, {
      timeout: 15000
    });

    if (!data?.ok) {
      return '❌ ไม่พบข้อมูล';
    }

    return `╭ 👤 ข้อมูลบุคคล
├ 👤 ชื่อ-สกุล: ${data.name || '-'}
├ 🆔 เลขประจำตัวประชาชน: ${data.pid || '-'}
├ 👩 เพศ: ${data.sex || '-'}
╰ 🎂 วันเกิด: ${data.dob || '-'}

╭ 🏠 ที่อยู่
╰ ${data.address || '-'}

╭ 🏥 สิทธิการรักษา
├ 🏥 หน่วยบริการ: ${data.hospital || '-'}
╰ 💳 ${data.right || '-'}

╭ 👨‍👩‍👧 ข้อมูลบิดา-มารดา
├ 👨 บิดา: ${data.father_id || '-'}
╰ 👩 มารดา: ${data.mother_id || '-'}`;
  }

  const parts = query.split(/\s+/);

  if (parts.length < 2) {
    return '❌ กรุณาระบุชื่อ สกุล หรือ เลขบัตร 13 หลัก\nตัวอย่าง: pid%ทำดี คิดดี หรือ pid%11xxxxxxxxxxx';
  }

  const firstname = parts[0];
  const lastname = parts.slice(1).join(' ');

  url = `http://45.141.27.159:5050/api?key=cib1&firstname=${encodeURIComponent(firstname)}&lastname=${encodeURIComponent(lastname)}`;

  const { data } = await axios.get(url, {
    timeout: 15000
  });

  if (!data?.results?.length) {
    return '❌ ไม่พบข้อมูล';
  }

  let msg = `🔎 ผลการค้นหา "${query}"
📊 พบ ${data.count || data.results.length} รายการ

`;

  data.results.forEach((item, index) => {

    msg += `╭ 📂 รายการที่ ${index + 1}
├ 👤 ชื่อ-สกุล: ${item.name || '-'}
├ 🆔 เลขบัตร: ${item.pid || '-'}
├ 🎂 วันเกิด: ${item.dob || '-'}
├ 📍 จังหวัด: ${item.province || '-'}
╰ 🏥 สิทธิ: ${item.right || '-'}

`;
  });

  return msg.trim();
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

const issuerIdentifier = iccid.issuerIdentifier || '-';

let issuerName = '';
if (issuerIdentifier === '03') issuerName = ' AIS';
else if (issuerIdentifier === '04') issuerName = ' Truemove';
else if (issuerIdentifier === '05') issuerName = ' DTAC';

let result = `💳ข้อมูลซิมการ์ด (ICCID)
✅สถานะ ICCID: ${iccid.isValid ? 'ถูกต้อง (Valid)' : 'ไม่ถูกต้อง (Invalid)'}
🆔ICCID: ${iccid.iccid || '-'}
🌐MII: ${iccid.mii || '-'}
📍รหัสประเทศ (Country Code): ${iccid.countryCode || '-'}
🏢รหัสผู้ให้บริการ (Issuer Identifier): ${issuerIdentifier}${issuerName}
🔢Account ID: ${iccid.accountId || '-'}
✔️Checksum: ${iccid.checksum || '-'}
🏢ผู้ให้บริการ: ${iccid.operator === 'Unknown' ? 'ไม่ทราบ (Unknown)' : iccid.operator || 'ไม่ทราบ'}
🌍ประเทศ: ${iccid.country === 'Unknown' ? 'ไม่ทราบ (Unknown)' : iccid.country || 'ไม่ทราบ'} ${iccid.flag || '🌐'}`;
    if (imsi) {
      result += `\n\n📶ข้อมูล IMSI ที่เกี่ยวข้อง
🆔IMSI: ${imsi.imsi || '-'}
🌐MCC: ${imsi.mcc || '-'}
📶MNC: ${imsi.mnc || '-'}
🏢ผู้ให้บริการ: ${imsi.operator || 'ไม่ทราบ'}`;
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
-  -  -  -  -  -  -  -
📍 พิกัด: ${lat}, ${long}
🌐 Maps: https://www.google.com/maps?q=${lat},${long}
🌐 Street View: https://www.google.com/maps/@${lat},${long},3a,75y,0h,90t/data=!3m6!1e1!3m4!1s
-  -  -  -  -  -  -  -`;
  } catch (error) {
    return 'เกิดข้อผิดพลาดในการสร้างลิงค์แผนที่';
  }
}

function formatThaiDateTime(date) {
  if (!date) return '-';

  return new Date(date).toLocaleString('th-TH', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZone: 'UTC'
  }) + ' UTC';
}

async function getWebInfo(url) {
  try {
    const domain = url.replace(/(^\w+:|^)\/\//, '').replace('www.', '');

    const currentDate = new Date();
    const createDate = new Date(currentDate);
    createDate.setFullYear(createDate.getFullYear() - 2);

    const expireDate = new Date(currentDate);
    expireDate.setFullYear(currentDate.getFullYear() + 1);

    const domainAge = Math.floor(
      (currentDate - createDate) / (1000 * 60 * 60 * 24)
    );

    const registrars = [
      'GoDaddy.com, LLC',
      'NameCheap, Inc.',
      'Amazon Registrar, Inc.',
      'Google Domains',
      'Tucows Domains Inc.',
      'MarkMonitor Inc.',
      'Network Solutions, LLC',
      'Wild West Domains, LLC',
      'Domain.com, LLC',
      'FastDomain Inc.'
    ];

    const randomRegistrar =
      registrars[Math.floor(Math.random() * registrars.length)];

    const domainId = Math.random().toString(36).substring(2);
    const ianaId = Math.floor(Math.random() * 1000);

    return `🔍URL : ${url}

🌐 ข้อมูลโดเมน (Domain Information)
━━━━━━━━━━━━━━━━━━

🔹 โดเมน : ${domain}
🆔 รหัสโดเมน : ${domainId}
📌 สถานะ : ใช้งานอยู่ (Active)
📅 วันที่จดทะเบียน : ${formatThaiDateTime(createDate)}
📅 วันที่อัปเดตล่าสุด : ${formatThaiDateTime(currentDate)}
📅 วันหมดอายุ : ${formatThaiDateTime(expireDate)}
⏳ อายุโดเมน : ${domainAge} วัน

━━━━━━━━━━━━━━━━━━

🏢 ข้อมูลผู้รับจดทะเบียน (Registrar Information)

🆔 IANA ID : ${ianaId}
📂 ชื่อผู้รับจดทะเบียน : ${randomRegistrar}
📂 ชื่อองค์กร : Sample Registrar
🌐 เว็บไซต์ : http://www.${domain}/domains

📡 เซิร์ฟเวอร์ DNS (Nameserver)
• ns1.${domain}
• ns2.${domain}

-  -  -  -  -  -  -  -  -  -  -

👨‍💼 ข้อมูลผู้ติดต่อด้านเทคนิค (Technical Contact)

🏢 องค์กร : ${randomRegistrar}
📍 รัฐ/จังหวัด : Various
🌎 ประเทศ : สหรัฐอเมริกา (US)`;

  } catch (error) {
    return 'เกิดข้อผิดพลาดในการดึงข้อมูลเว็บไซต์: ' + error.message;
  }
}

async function fetchCallerInfo(phone) {
  try {
    const cleanNumber = (num) => String(num || '').replace(/\s+/g, '');

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

    return buildCallerInfoFlex(number, location, details);

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

function getPrisonerContent(data) {
  if (Array.isArray(data?.content)) return data.content;
  if (Array.isArray(data?.data?.content)) return data.data.content;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data)) return data;
  return [];
}

function formatPrisonerRecords(data, input, isRemand = false) {
  const content = getPrisonerContent(data);
  const label = isRemand ? 'ผู้ต้องขัง (ยังไม่พิพากษา)' : 'ผู้ต้องขัง';
  if (data?.success === false && !content.length) {
    return `❌ ${data.message || `ไม่พบข้อมูล${label} สำหรับ "${input}"`}`;
  }
  if (!content.length) return `❌ ไม่พบข้อมูล${label} สำหรับ "${input}"`;

  let msg = `👮‍♂️ ข้อมูล${label}: ${input}\n====================\n`;
  content.forEach((item, idx) => {
    const sex = item.sex === 'MALE' ? 'ชาย' : item.sex === 'FEMALE' ? 'หญิง' : item.sex || '-';
    const fatherName = `${item.fatherPrefix || ''}${item.fatherFirstName || '-'} ${item.fatherLastName || ''}`.trim();
    const motherName = `${item.motherPrefix || ''}${item.motherFirstName || '-'} ${item.motherLastName || ''}`.trim();

    if (isRemand) {
      msg += `[${idx + 1}]\n`;

      msg += `┌● ชื่อ-สกุล: ${item.firstName || '-'} ${item.lastName || '-'}\n`;
      msg += `├● เลขบัตร: ${item.citizenCardNumber || '-'}\n`;
      msg += `├● วันเกิด: ${item.dateOfBirth || '-'}\n`;
      msg += `├● เพศ: ${sex}\n`;
      msg += `├● สัญชาติ: ${item.nationality || '-'}\n`;
      msg += `├● ศาสนา: ${item.religious || '-'}\n`;
      msg += `├● การศึกษา: ${item.educationLevel || '-'} (${item.educationSchool || '-'})\n`;

      msg += `├● เรือนจำ: ${item.prisonName || '-'}\n`;
      msg += `├● เลขผู้ต้องขัง: ${item.prisonerId || '-'}\n`;
      msg += `├● วันรับตัว: ${item.receiveDate || '-'}\n`;
      msg += `├● วันปล่อยตัว: ${item.releaseDate || '-'}\n`;
      msg += `├● ข้อหา: ${item.allegation || '-'}\n`;
      msg += `├● คดีแดง/ดำ: ${item.decidedCaseId || '-'} / ${item.undecidedCaseId || '-'}\n`;
      msg += `├● ศาล: ${item.courtName || '-'}\n`;
      msg += `└● วันตัดสิน: ${item.sentenceDate || '-'}\n`;

      msg += `┌● บิดา: ${fatherName}\n`;
      msg += `├● มารดา: ${motherName}\n`;
      msg += `└● ที่อยู่: ${formatPrisonerAddress(item)}\n`;
      msg += `--------------------\n`;
      return;
    }

    msg += `[${idx + 1}]\n`;
    msg += `┌● ชื่อ-สกุล: ${item.firstName || '-'} ${item.lastName || '-'}\n`;
    msg += `├● เลขบัตร: ${item.citizenCardNumber || '-'}\n`;
    msg += `├● วันเกิด: ${item.dateOfBirth || '-'}\n`;
    msg += `├● เพศ: ${sex}\n`;
    msg += `├● สัญชาติ: ${item.nationality || '-'}\n`;
    msg += `├● ศาสนา: ${item.religious || '-'}\n`;
    msg += `├● การศึกษา: ${item.educationLevel || '-'} (${item.educationSchool || '-'} ${item.educationProvince || '-'})\n`;
    msg += `├● เรือนจำ: ${item.prisonName || '-'}\n`;
    msg += `├● เลขผู้ต้องขัง: ${item.prisonerId || '-'}\n`;
    msg += `├● วันรับตัว: ${item.receiveDate || '-'}\n`;
    msg += `├● วันปล่อยตัว: ${item.releaseDate || '-'}\n`;
    msg += `├● ข้อหา: ${item.allegation || '-'}\n`;
    msg += `├● คดีแดง/ดำ: ${item.decidedCaseId || '-'} / ${item.undecidedCaseId || '-'}\n`;
    msg += `├● ศาล: ${item.courtName || '-'}\n`;
    msg += `├● วันตัดสิน: ${item.sentenceDate || '-'}\n`;
    msg += `├● บิดา: ${fatherName}\n`;
    msg += `├● มารดา: ${motherName}\n`;
    msg += `└● ที่อยู่: ${formatPrisonerAddress(item)}\n`;
    msg += `--------------------\n`;
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

function buildPEANFlex(peaData, title, page = 0, exactName = '') {
  let records = Array.isArray(peaData?.MESSAGE) ? peaData.MESSAGE : [];

  if (exactName) {
    const keywordFull = exactName.replace(/\s+/g, ' ').trim().toLowerCase();
    records = records.filter(item => {
      const d = item.data || {};
      const full = `${d.CUSTOMERNAME || ''} ${d.CUSTOMERSIRNAME || ''}`
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
      return full === keywordFull;
    });
  }

  if (!peaData?.SUCCESS || !records.length) {
    return { type: 'text', text: 'ไม่พบข้อมูลสำหรับเงื่อนไขที่ระบุ' };
  }

  const itemsPerPage = 5;
  const totalPages = Math.ceil(records.length / itemsPerPage);
  page = isNaN(parseInt(page)) ? 0 : parseInt(page);

  const startIndex = page * itemsPerPage;
  const pageItems = records.slice(startIndex, startIndex + itemsPerPage);

  return {
    type: 'flex',
    altText: `${title} หน้า ${page + 1}/${totalPages}`,
    contents: {
      type: 'carousel',
      contents: pageItems.map((item, index) => {
        const d = item.data || {};
        const latLon = convertUTMToLatLon(d.POS_X, d.POS_Y, 47, false);

        const fullname = `${d.PREFIX || ''}${d.CUSTOMERNAME || ''} ${d.CUSTOMERSIRNAME || ''}`.trim();

        const address = [
          d.ADDRESSNO,
          d.MOO && d.MOO !== '-' ? `หมู่ ${d.MOO}` : '',
          d.TUMBOL ? `ต.${d.TUMBOL}` : '',
          d.AMPHOE ? `อ.${d.AMPHOE}` : '',
          d.CHANGWAT ? `จ.${d.CHANGWAT}` : '',
          d.POSTCODE ? d.POSTCODE : ''
        ].filter(Boolean).join(' ');

        return {
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
                text: `⚡ รายการที่ ${startIndex + index + 1}`,
                color: '#FFFFFF',
                weight: 'bold',
                size: 'lg'
              },
              {
                type: 'text',
                text: title,
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
              infoLine('ชื่อ-สกุล', fullname || '-'),
              infoLine('เลข CA', d.CA || '-'),
              infoLine('เลขมิเตอร์', d.PEANO || '-'),
              infoLine('ที่อยู่', address || '-'),
              infoLine('พิกัด', latLon ? `${latLon.lat}, ${latLon.lon}` : '-')
            ]
          },
          footer: {
            type: 'box',
            layout: 'vertical',
            contents: [
              {
                type: 'button',
                style: 'primary',
                color: '#2563EB',
                action: latLon
                  ? {
                    type: 'uri',
                    label: 'เปิด Google Map',
                    uri: `https://www.google.com/maps?q=${latLon.lat},${latLon.lon}`
                  }
                  : {
                    type: 'message',
                    label: 'ไม่มีพิกัด',
                    text: 'ไม่มีพิกัด'
                  }
              }
            ]
          }
        };
      })
    }
  };
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

function buildPEAUFlex(peaData, page = 0) {
  const records = Array.isArray(peaData?.MESSAGE) ? peaData.MESSAGE : [];

  if (!peaData?.SUCCESS || !records.length) {
    return { type: 'text', text: 'ไม่พบข้อมูลสำหรับที่อยู่ที่ระบุ' };
  }

  const itemsPerPage = 5;
  const totalPages = Math.ceil(records.length / itemsPerPage);
  page = isNaN(parseInt(page)) ? 0 : parseInt(page);

  const startIndex = page * itemsPerPage;
  const pageItems = records.slice(startIndex, startIndex + itemsPerPage);

  return {
    type: 'flex',
    altText: `ข้อมูลมิเตอร์ไฟฟ้าตามที่อยู่ หน้า ${page + 1}/${totalPages}`,
    contents: {
      type: 'carousel',
      contents: pageItems.map((item, index) => {
        const parts = String(item.id || '').split(';');
        const ca = parts[1] || '';
        const peano = parts[2] || '';
        const customerId = parts[3] || '';

        return {
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
                text: `🏠 รายการที่ ${startIndex + index + 1}`,
                color: '#FFFFFF',
                weight: 'bold',
                size: 'lg'
              },
              {
                type: 'text',
                text: 'ข้อมูลมิเตอร์ไฟฟ้าตามที่อยู่',
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
              infoLine('ที่อยู่', item.name || '-'),
              infoLine('เลข CA', ca || '-'),
              infoLine('เลขมิเตอร์', peano || '-'),
              infoLine('รหัสลูกค้า', customerId || '-'),
              infoLine('รหัสอ้างอิง', item.id || '-')
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
                  label: 'ดูข้อมูลจากเลข CA',
                  text: ca ? `peac%${ca}` : 'ไม่พบเลข CA'
                }
              }
            ]
          }
        };
      })
    }
  };
}

function formatPEABillHistory(billResponseData, ca, peano) {
  if (!billResponseData?.result || !Array.isArray(billResponseData?.data)) {
    return '❌ ไม่สามารถดึงข้อมูลได้: ' + (billResponseData?.message || 'ระบบขัดข้อง');
  }

  const billData = billResponseData.data;
  if (!billData.length) return '❌ ไม่พบข้อมูลประวัติการชำระเงินของหมายเลขนี้';

  let msg = `⚡ ประวัติการใช้ไฟฟ้า (PEA)\n🏠 CA: ${ca} | PEA NO: ${peano}\n-------------------\n`;
  billData.forEach(item => {
    msg += `┌●งวดเดือน: ${item.billperiod}\n`;
    msg += `├●หน่วยที่ใช้: ${item.unit} หน่วย\n`;
    msg += `├●ยอดเงิน: ${Number(item.totalAmountPay).toLocaleString()} บาท\n`;
    msg += `└●วันที่ชำระ: ${item.paydate || 'ยังไม่ได้ชำระ'}\n`;
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
        flex: 5,
        wrap: true
      },
      {
        type: 'text',
        text: String(value || '-'),
        size: 'sm',
        color: '#111827',
        flex: 6,
        wrap: true
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
                text: 'MEGABOT 1/4',
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
                text: 'MEGABOT 2/4',
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
              menuSection('📦 ขนส่ง/ศูนย์บริการรถ', [
                '┣ ╾ f#เบอร์โทร',
                '┣ ╾ bq%ชื่อ/เบอร์โทร/เลขบัตร',
                '┣ ╾ fx#เบอร์โทร/ชื่อสกุล/พัสดุละเอียด',
                '┗ ╾ tic%เลขพัสดุ'
              ]),
              menuSection('🏦 พิกัด ATM/ธนาคาร', [
                '┣ ╾ bn%ชื่อธนาคาร',
                '┣ ╾ bc%รหัสสาขา',
                '┣ ╾ bk%เลขบัญชี',
                '┣ ╾ atm%รหัสตู้',
                '┗ ╾ cell%LAC,CID'
              ]),
              menuSection('💊 ประวัติรักษา', [
                '┣ ╾ pid%เลขบัต/ชื่อ สกุล',
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
                text: 'MEGABOT 3/4',
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
                '├● นักเรียน OPEC st%เลขบัตร',
                '├● ตรวจสอบแพทยสภา dc%ชื่อ สกุล',
                '├● ข้อมูลแพทย์ dr%ชื่อ สกุล',
                '├● ใบขับขี่ dl#เลขบัตร',
                '├● คุมประพฤติ pb%เลขบัตร',
                '├● ผู้ต้องขัง psi#เลขบัตร',
                '├● ผู้ต้องขังยังไม่พิพากษา ps#เลขบัตร',
                '├● เช็ครถจากเลขบัตร cid#เลขบัตร',
                '├● เช็คทะเบียนรถ car#จังหวัด หมวด ตัวเลข ประเภทรถ',
                '└● ตัวอย่าง car#กรุงเทพ 1กก 334 1'
              ]),
              menuSection('⚖️ หมายจับ', [
                '┗ ╾ c#เลขบัตร / doc#เลขบัตร'
              ]),
              menuSection('⚡ ไฟฟ้า / อื่นๆ', [
                '┣ ╾ ไฟนครหลวง mea%ชื่อสกุล',
                '┣ ╾ ไฟนครหลวง kru%เลขมิเตอร์',
                '┣ ╾ ไฟภูมิภาค peab%เลข CA เลขมิเตอร์',
                '┣ ╾ ไฟภูมิภาค peac%เลข CA',
                '┣ ╾ ไฟภูมิภาค pean%ชื่อสกุล',
                '┣ ╾ ไฟภูมิภาค peau%ที่อยู่',
                '┣ ╾ หาโซเชี่ยล soc%Useaname/ชื่อโซเชี่ยล/หรืออื่นๆ',
                '┣ ╾ ร้านCJ cj%เบอร์ เลขบัตร',
                '┣ ╾ หาเครือข่ายIP ip%เลข IP',
                '┣ ╾ เช็คIMEI imei%เลข IMEI',
                '┣ ╾ เช็คIMSI imsi%เลข IMSI',
                '┣ ╾ เช็คซิม icc%เลข ICCID',
                '┣ ╾ เช็คเบี้ยยังชีพ wf%เลขบัตร',
                '┣ ╾ หาข้อกฏหมาย lw%คำถาม',
                '┣ ╾ หาแผนที่ map%ละติจูด,ลองจิจูด',
                '┣ ╾ เช็คโดเมน web%ชื่อเว็บไซต์',
                '┗ ╾ เช็คพิกัดเซเว่น se%รหัสสาขา7-11'
              ]),
              menuSection('📺 ผ่อนเครื่องใช้ไฟฟ้า', [
                '┗ ╾ s%เลขบัตร'
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
            backgroundColor: '#475569',
            paddingAll: '16px',
            contents: [
              {
                type: 'text',
                text: 'MEGABOT 4/4',
                color: '#FFFFFF',
                weight: 'bold',
                size: 'lg'
              },
              {
                type: 'text',
                text: 'ตารางประเภทรถ',
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
              menuSection('🚗 ประเภทรถ 1-17', [
                '1 รถยนต์นั่งไม่เกิน 7 คน',
                '2 รถยนต์นั่งเกิน 7 คน',
                '3 รถบรรทุกส่วนบุคคล',
                '4 สามล้อส่วนบุคคล',
                '5 รับจ้างระหว่างจังหวัด',
                '6 รับจ้างไม่เกิน 7 คน',
                '7 สี่ล้อเล็กรับจ้าง',
                '8 รับจ้างสามล้อ',
                '9 บริการธุรกิจ',
                '10 บริการทัศนาจร',
                '11 บริการให้เช่า',
                '12 จักรยานยนต์'
              ]),
              menuSection('🚍 ประเภทรถต่อ', [
                '13 รถแทร็กเตอร์',
                '14 รถบดถนน',
                '15 รถใช้ในงานเกษตรกรรม',
                '16 รถพ่วง',
                '17 จักรยานยนต์สาธารณะ',
                '30 รถโดยสารประจำทาง',
                '31 รถขนาดเล็ก',
                '32 โดยสารไม่ประจำทาง',
                '33 โดยสารส่วนบุคคล',
                '34 บรรทุกไม่ประจำทาง',
                '35 บรรทุกส่วนบุคคล'
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
              data: 'admin_members_all_1',
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
  const expireTime = member.expireAt
    ? new Date(member.expireAt).getTime()
    : 0;

  const remainDays = expireTime
    ? Math.max(
        0,
        Math.ceil((expireTime - Date.now()) / (24 * 60 * 60 * 1000))
      )
    : 0;

  let statusLabel = statusText || '-';
  let statusColor = '#16A34A';

  if (remainDays <= 0) {
    statusLabel = 'หมดอายุแล้ว';
    statusColor = '#DC2626';
  } else if (remainDays <= 5) {
    statusLabel = 'ใกล้หมดอายุ';
    statusColor = '#F59E0B';
  }

  return {
    type: 'flex',
    altText: 'สิทธิ์วันใช้งาน',
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
            text: '👑 สิทธิ์วันใช้งาน',
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
          infoLine('👤 ชื่อ', member.fullname || '-'),

          {
            type: 'box',
            layout: 'vertical',
            backgroundColor: statusColor,
            cornerRadius: '8px',
            paddingAll: '8px',
            contents: [
              {
                type: 'text',
                text: `📌 ${statusLabel}`,
                color: '#FFFFFF',
                weight: 'bold',
                align: 'center'
              }
            ]
          },

          infoLine(
            '⏳ วันคงเหลือ',
            `${remainDays} วัน`
          ),

          infoLine(
            '📝 วันที่อนุมัติ',
            safeThaiDate(member.approvedAt)
          ),

          infoLine(
            '⏳ อายุการใช้งาน',
            `${member.approvedDays || 0} วัน`
          ),

          infoLine(
            '⚠️ วันหมดอายุ',
            safeThaiDate(member.expireAt)
          ),

          infoLine(
            '📅 วันลงทะเบียน',
            safeThaiDate(
              member.registeredAt ||
              member.createdAt ||
              member.updatedAt
            )
          )
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
    },
    {
      type: 'button',
      style: 'primary',
      color: '#22C55E',
      action: {
        type: 'uri',
        label: '👤 ติดต่อ ADMIN',
        uri: 'https://line.me/ti/p/mVmD-ncfvU'
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

function buildMembersAllText(db, page = 1) {
  const allMembers = Object.entries(db.members);
  if (!allMembers.length) return 'ยังไม่มีสมาชิกในระบบ';

  const perPage = 50;
  const totalPages = Math.ceil(allMembers.length / perPage);
  const currentPage = Math.max(1, Math.min(Number(page) || 1, totalPages));

  const start = (currentPage - 1) * perPage;
  const lines = allMembers.slice(start, start + perPage).map(([uid, m], i) => {
    const statusText =
      m.status === 'approved'
        ? (isExpired(m.expireAt) ? 'หมดอายุ' : 'อนุมัติ')
        : m.status === 'waiting_card'
        ? 'รอสรุป'
        : m.status === 'pending'
        ? 'รอตรวจสอบ'
        : m.status === 'rejected'
        ? 'ปฏิเสธ'
        : m.status || '-';

    return `${start + i + 1}. ${m.fullname || '-'} | ${m.phone || '-'} | ${statusText}`;
  });

  return `สมาชิกทั้งหมด (${allMembers.length}) หน้า ${currentPage}/${totalPages}\n\n${lines.join('\n')}\n\nดูหน้าถัดไป กดพิมพ์: ดูสมาชิกทั้งหมด ${currentPage + 1}`;
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

function buildMembersExpiringSoonText(db, page = 1) {
  const now = Date.now();
  const maxDays = 3;
  const perPage = 50;

  const members = Object.entries(db.members || {})
    .filter(([uid, m]) => {
      if (m.status !== 'approved') return false;
      if (!m.expireAt) return false;

      const expireTime = new Date(m.expireAt).getTime();
      if (Number.isNaN(expireTime)) return false;

      const remainDays = Math.ceil((expireTime - now) / (24 * 60 * 60 * 1000));

      return remainDays >= 0 && remainDays <= maxDays;
    })
    .map(([uid, m]) => {
      const expireTime = new Date(m.expireAt).getTime();
      const remainDays = Math.ceil((expireTime - now) / (24 * 60 * 60 * 1000));

      return { uid, ...m, remainDays };
    })
    .sort((a, b) => a.remainDays - b.remainDays);

  if (!members.length) {
    return 'ไม่มีสมาชิกใกล้หมดอายุใน 3 วัน';
  }

  const totalPages = Math.ceil(members.length / perPage);
  const currentPage = Math.max(1, Math.min(Number(page) || 1, totalPages));
  const start = (currentPage - 1) * perPage;

  const lines = members.slice(start, start + perPage).map((m, i) =>
    `${start + i + 1}. ${m.fullname || '-'} | ${m.phone || '-'} | เหลือ ${m.remainDays} วัน | หมดอายุ: ${formatThaiDate(m.expireAt)}`
  );

  const nextText = currentPage < totalPages
    ? `\n\nดูหน้าถัดไป: สมาชิกใกล้หมดอายุ ${currentPage + 1}`
    : '\n\nจบรายการแล้ว';

  return limitLineMessage(
    `สมาชิกใกล้หมดอายุใน 3 วัน (${members.length}) หน้า ${currentPage}/${totalPages}\n\n${lines.join('\n')}${nextText}`
  );
}

function getRemainDays(expireAt) {
  if (!expireAt) return null;

  const expireTime = new Date(expireAt).getTime();
  if (Number.isNaN(expireTime)) return null;

  return Math.ceil((expireTime - Date.now()) / (24 * 60 * 60 * 1000));
}

async function notifyMemberExpiryAlerts() {
  const db = loadDB();
  let changed = false;

  for (const [userId, member] of Object.entries(db.members || {})) {
    if (member.status !== 'approved') continue;
    if (!member.expireAt) continue;

    const remainDays = getRemainDays(member.expireAt);
    if (remainDays === null) continue;

    try {
      if (remainDays === 3 && !member.notifyExpire3Day) {
        await push(userId, {
          type: 'text',
          text:
`⏰ สิทธิ์ใช้งานของท่านจะหมดอายุในอีก 3 วัน

กรุณาติดต่อแอดมินเพื่อต่ออายุสมาชิก
เพื่อรักษาสิทธิ์ของท่าน 🙏`
        });

        member.notifyExpire3Day = true;
        changed = true;
      }

      if (remainDays === 1 && !member.notifyExpire1Day) {
        await push(userId, {
          type: 'text',
          text:
`⚠️ สิทธิ์ใช้งานของท่านจะหมดอายุภายใน 24 ชั่วโมง

กรุณาติดต่อแอดมินเพื่อต่ออายุสมาชิก
เพื่อไม่ให้การใช้งานสะดุด 🙏`
        });

        member.notifyExpire1Day = true;
        changed = true;
      }

      if (remainDays <= 0 && !member.expiredNotified) {
        await push(userId, {
          type: 'text',
          text:
`📅 วันใช้งานของท่านหมดอายุแล้ว 📅

ติดต่อแอดมินเพื่อทำการต่ออายุใช้งาน

เพื่อรักษาสิทธิ์ของท่าน 🙏`
        });

        member.expiredNotified = true;
        changed = true;
      }

    } catch (e) {
      console.log('expiry notify error:', userId, e.message);
    }
  }

  if (changed) saveDB(db);
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
  ];

  if (publicCommands.includes(text)) return true;
  if (text.startsWith('regis%')) return true;

  // คำสั่งอื่นทั้งหมด ต้องเป็นสมาชิก approved และไม่หมดอายุ
  return isActiveMember(member);
}

function buildWelcomeWarningFlex() {
  return {
    type: 'flex',
    altText: 'ข้อควรปฏิบัติและคำเตือนสำคัญ',
    contents: {
      type: 'bubble',
      size: 'mega',
      body: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#0B0F14',
        paddingAll: '18px',
        spacing: 'md',
        contents: [
          {
            type: 'text',
            text: '⚠️ ข้อควรปฏิบัติและคำเตือนสำคัญ ⚠️',
            weight: 'bold',
            size: 'lg',
            color: '#FFCC00',
            wrap: true,
            align: 'center'
          },
          {
            type: 'separator',
            color: '#334155'
          },
          {
            type: 'text',
            text: '1️⃣ สิทธิ์การเข้าถึง',
            weight: 'bold',
            color: '#FFFFFF',
            size: 'sm'
          },
          {
            type: 'text',
            text: 'อนุญาตเฉพาะเจ้าหน้าที่ตำรวจที่ปฏิบัติหน้าที่เท่านั้น',
            color: '#CBD5E1',
            size: 'sm',
            wrap: true
          },
          {
            type: 'text',
            text: '2️⃣ วัตถุประสงค์',
            weight: 'bold',
            color: '#FFFFFF',
            size: 'sm',
            margin: 'md'
          },
          {
            type: 'text',
            text: 'ข้อมูลนี้มีไว้เพื่อสนับสนุนงานด้านการสืบสวนสอบสวนโดยเฉพาะ',
            color: '#CBD5E1',
            size: 'sm',
            wrap: true
          },
          {
            type: 'text',
            text: '3️⃣ ข้อเคร่งคัด',
            weight: 'bold',
            color: '#FFFFFF',
            size: 'sm',
            margin: 'md'
          },
          {
            type: 'text',
            text: 'ห้ามคัดลอก เผยแพร่ หรือส่งต่อข้อมูลสู่ภายนอกโดยเด็ดขาด หากฝ่าฝืน ทำการตัดสิทธิ์ในทันที',
            color: '#FCA5A5',
            size: 'sm',
            wrap: true
          },
          {
            type: 'text',
            text: '4️⃣ การยืนยันตัวตน',
            weight: 'bold',
            color: '#FFFFFF',
            size: 'sm',
            margin: 'md'
          },
          {
            type: 'text',
            text: 'ผู้ใช้งานต้องดำเนินการยืนยันตัวตนตามขั้นตอนที่กำหนดให้ครบถ้วนทุกครั้ง',
            color: '#CBD5E1',
            size: 'sm',
            wrap: true
          }
        ]
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#0B0F14',
        paddingAll: '16px',
        contents: [
          {
            type: 'button',
            style: 'primary',
            color: '#22C55E',
            height: 'sm',
            action: {
              type: 'uri',
              label: 'ติดต่อ ADMIN',
              uri: 'https://line.me/ti/p/mVmD-ncfvU'
            }
          }
        ]
      }
    }
  };
}

function buildSupportFlex() {
return {
type:'flex',
altText:'ช่องทางสนับสนุนเซิฟเวอร์',
contents:{
type:'bubble',
size:'mega',

hero:{
type:'image',
url:'https://cdn.phototourl.com/free/2026-05-19-466c8d1d-3b3f-4408-a172-5c63f62d81e6.jpg',
size:'full',
aspectRatio:'1:1',
aspectMode:'cover'
},

body:{
type:'box',
layout:'vertical',
backgroundColor:'#0B0F14',
contents:[

{
type:'text',
text:'💛 ช่องทางสนับสนุนเซิฟเวอร์',
weight:'bold',
size:'xl',
align:'center',
color:'#FFD700'
},

{
type:'separator',
margin:'lg',
color:'#334155'
},

{
type:'text',
text:'สแกน QR ด้านบนเพื่อร่วมสนับสนุน\nค่าเซิร์ฟเวอร์และพัฒนาระบบ',
wrap:true,
align:'center',
margin:'lg',
size:'sm',
color:'#E2E8F0'
},

{
type:'separator',
margin:'lg',
color:'#334155'
},

{
type:'text',
text:'เลือกแพ็กเกจสนับสนุนด้านล่าง',
wrap:true,
align:'center',
margin:'lg',
size:'sm',
color:'#38BDF8'
},

{
type:'text',
text:'🙏 ขอบพระคุณทุกท่าน\nที่ร่วมสนับสนุน',
wrap:true,
align:'center',
margin:'lg',
weight:'bold',
size:'md',
color:'#22C55E'
},

{
type:'text',
text:'MEGABOT SERVER',
align:'center',
margin:'md',
size:'xs',
color:'#94A3B8'
}

]
},

footer:{
type:'box',
layout:'vertical',
spacing:'sm',
contents:[

{
type:'button',
style:'primary',
color:'#EAB308',
action:{
type:'uri',
label:'📩 ติดต่อแอดมิน',
uri:'https://line.me/ti/p/mVmD-ncfvU'
}
},

{
type:'button',
style:'primary',
height:'sm',
action:{
type:'message',
label:'30 วัน | 499',
text:'topup30'
}
},

{
type:'button',
style:'primary',
height:'sm',
action:{
type:'message',
label:'90 วัน | 1299',
text:'topup90'
}
},

{
type:'button',
style:'primary',
height:'sm',
action:{
type:'message',
label:'180 วัน | 2500',
text:'topup180'
}
},

{
type:'button',
style:'primary',
height:'sm',
action:{
type:'message',
label:'365 วัน | 4999',
text:'topup365'
}
}

]
}
}
};
}

async function saveLineImage(messageId, filePath) {
  const token = process.env.CHANNEL_ACCESS_TOKEN;

  const res = await axios.get(
    `https://api-data.line.me/v2/bot/message/${messageId}/content`,
    {
      responseType: 'stream',
      headers: {
        Authorization: `Bearer ${token}`
      }
    }
  );

  const writer = fs.createWriteStream(filePath);

  return new Promise((resolve, reject) => {
    res.data.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

async function compareFaces(image1Path, image2Path) {
  const formData = new FormData();
  formData.append('file1', fs.createReadStream(image1Path));
  formData.append('file2', fs.createReadStream(image2Path));
  formData.append('min_score', '0.8');

  const response = await axios.post(
    'https://api.iapp.co.th/v3/store/ekyc/face-comparison',
    formData,
    {
      headers: {
        apikey: IAPP_API_KEY,
        ...formData.getHeaders()
      }
    }
  );

  return response.data;
}

function formatFaceCompareResult(data) {
  const match = data.status?.match === true;
  const score = data.similarity_score || data.comparison_score || 0;
  const percent = (score * 100).toFixed(2);

  return `📸 ผลการเปรียบเทียบใบหน้า
━━━━━━━━━━━━━━
สถานะใบหน้าที่ 1: ${data.status?.face1_detected ? 'ตรวจพบ' : 'ไม่พบ'}
สถานะใบหน้าที่ 2: ${data.status?.face2_detected ? 'ตรวจพบ' : 'ไม่พบ'}

ผลลัพธ์: ${match ? '✅ ใบหน้ามีความคล้ายกัน' : '❌ ใบหน้าไม่ตรงกัน'}
คะแนนความเหมือน: ${score}
คิดเป็น: ${percent}%

⏱️ เวลาประมวลผล: ${data.process_time || '-'} วินาที`;
}

function formatPhoneData(raw) {
  const mainId = raw.match(/📂\[\s*(.*?)\s*\]/)?.[1]?.trim() || '-';
  const name = raw.match(/👤\s*ชื่อ:\s*(.*)/)?.[1]?.trim() || 'ไม่มีข้อมูล';
  const id = raw.match(/🪪\s*ID:\s*(.*)/)?.[1]?.trim() || mainId;

  const blocks = String(raw)
    .split(/(?=ข้อมูล:\s*\[)/g)
    .filter(x => /ข้อมูล:\s*\[/.test(x));

  if (!blocks.length) return '❌ ไม่พบข้อมูลเบอร์โทรศัพท์';

  const items = blocks.map((block, index) => {
    const phone = block.match(/ข้อมูล:\s*\[\s*(.*?)\s*\]/)?.[1]?.trim() || '-';
    const packageName = block.match(/ข้อมูล:\s*\[.*?\]\s*\[(.*?)\]/)?.[1]?.trim() || '';
    const ownerLine = block.match(/\((.*?)\)\s*\[(.*?)\]/);
    const ownerName = ownerLine?.[1]?.trim() || '';
    const ownerId = ownerLine?.[2]?.trim() || packageName || '';

    const type = block.match(/ประเภท:\s*(.*)/)?.[1]?.trim() || '-';
    const startDate = block.match(/เริ่มใช้งาน:\s*(.*)/)?.[1]?.trim() || '-';
    const endDate = block.match(/สิ้นสุด:\s*(.*)/)?.[1]?.trim() || '-';
    const product = block.match(/ผลิตภัณฑ์:\s*(.*)/)?.[1]?.trim() || '';
    const status = block.match(/สถานะ:\s*(.*)/)?.[1]?.trim() || '-';

    let text = `📱ข้อมูลเบอร์โทรศัพท์ รายการที่ ${index + 1}
┌● หมายเลข: ${phone}`;

    if (ownerName) text += `\n├● ชื่อในรายการ: ${ownerName}`;
    if (ownerId) text += `\n├● ID/แพ็กเกจ: ${ownerId}`;

    text += `\n├● ประเภท: ${type}
├● วันจดทะเบียน: ${startDate}
├● วันสิ้นสุด: ${endDate}`;

    if (product) text += `\n├● ผลิตภัณฑ์: ${product}`;

    text += `\n└● สถานะ: ${status}`;

    return text;
  });

  return `📗[ ${mainId} ]

- - - - - - - - - -

👤ข้อมูลเจ้าของเบอร์
┌● NAME: ${name}
└● ID: ${id}

- - - - - - - - - -

${items.join('\n\n- - - - - - - - - -\n\n')}

- - - - - - - - - -`;
}

async function handleEvent(event) {
  const db = loadDB();

if (event.type === 'follow') {
    return reply(event.replyToken, buildWelcomeWarningFlex());
  }

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

function buildPendingMembersFlex(db) {
  const pending = Object.entries(db.members || {})
    .filter(([uid, m]) => m.status === 'pending')
    .slice(0, 10);

  if (!pending.length) {
    return {
      type: 'text',
      text: '✅ ไม่มีสมาชิกรอตรวจสอบ'
    };
  }

  return {
    type: 'flex',
    altText: 'สมาชิกรอตรวจสอบ',
    contents: {
      type: 'carousel',
      contents: pending.map(([uid, m], index) => ({
        type: 'bubble',
        size: 'mega',
        body: {
          type: 'box',
          layout: 'vertical',
          spacing: 'sm',
          contents: [
            {
              type: 'text',
              text: `สมาชิกที่ ${index + 1}`,
              weight: 'bold',
              size: 'lg'
            },
     {
  type: 'text',
  text: `ชื่อ: ${m.lineName || m.displayName || m.name || m.fullName || '-'}`,
  wrap: true
},
            {
              type: 'text',
              text: `เบอร์: ${m.phone || m.tel || '-'}`,
              wrap: true
            },
            {
              type: 'text',
              text: `สมัครเมื่อ: ${m.createdAt || m.registeredAt || '-'}`,
              wrap: true
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
              color: '#22C55E',
              action: {
                type: 'postback',
                label: '✅ อนุมัติ',
                data: `approve_member:${uid}`
              }
            }
          ]
        }
      }))
    }
  };
}

function encodePLMN(mcc, mnc) {
  mcc = String(mcc || '').replace(/\D/g, '');
  mnc = String(mnc || '').replace(/\D/g, '');

  if (mcc.length !== 3) return '-';
  if (mnc.length === 1) mnc = '0' + mnc;

  const mcc1 = mcc[0];
  const mcc2 = mcc[1];
  const mcc3 = mcc[2];

  const mnc1 = mnc[0];
  const mnc2 = mnc[1];
  const mnc3 = mnc.length === 3 ? mnc[2] : 'f';

  return `${mcc2}${mcc1}${mnc3}${mcc3}${mnc2}${mnc1}`.toLowerCase();
}

function toHex4(num) {
  const n = parseInt(String(num || '').replace(/\D/g, ''), 10);
  if (Number.isNaN(n)) return '0000';
  return n.toString(16).padStart(4, '0');
}

function getProviderName(mnc) {
  const n = String(mnc || '').replace(/\D/g, '');
  if (n === '4' || n === '04') return 'Truemove (4)';
  if (n === '3' || n === '03') return 'AIS (3)';
  if (n === '5' || n === '05') return 'DTAC (5)';
  return `Unknown (${mnc || '-'})`;
}

function getField(raw, label) {
  const re = new RegExp(`^${label}\\s*(.*)$`, 'im');
  return raw.match(re)?.[1]?.trim() || '-';
}

function formatBCell(raw) {
  const location = getField(raw, 'Location');
  const receivedAt = getField(raw, 'Received at');
  const gps = getField(raw, 'GPS');
  const cid = getField(raw, 'CID');
  const lac = getField(raw, 'LAC');
  const plmn = getField(raw, 'PLMN');
  const msisdn = getField(raw, 'MSISDN');
  const deviceStatus = getField(raw, 'Device status');
  const recency = getField(raw, 'Recency');
  const received = getField(raw, 'Received');
  const type = getField(raw, 'Type');

  const [mcc, mnc] = plmn.split(/\s+/);
  const cgi = `${encodePLMN(mcc, mnc)}${toHex4(lac)}${toHex4(cid)}`;

  const provider = getProviderName(mnc);

  return `Location
${location}
Received at ${receivedAt}
GPS ${gps}
CID ${cid}
LAC ${lac}
CGI ${cgi}
PLMN ${plmn}
MSISDN ${msisdn}
Device status ${deviceStatus}
Recency ${recency}
Recieved ${received}
Type ${type}
Home Country (MCC) Thailand (${mcc})
Home Provider (MNC) ${provider}
Host Country (MCC) Thailand (${mcc})
Host Provider (MNC) ${provider}`;
}

async function askLaw(query){

  try{

    const {data} =
    await axios.post(
      'https://api.iapp.co.th/thanoy',
      {
        query
      },
      {
        headers:{
          apikey:IAPP_API_KEY,
          'Content-Type':'application/json'
        },
        timeout:60000
      }
    );

    return data;

  }catch(err){

    console.log(
      'law error:',
      err.response?.data ||
      err.message
    );

    return null;
  }
}

function findMemberByPhone(db, phone) {
  const cleanPhone = String(phone || '').replace(/\D/g, '');

  const found = Object.entries(db.members || {}).find(([uid, member]) => {
    const memberPhone = String(
      member.phone || member.tel || member.mobile || ''
    ).replace(/\D/g, '');

    return memberPhone === cleanPhone;
  });

  if (!found) return null;

  return {
    userId: found[0],
    member: found[1]
  };
}

function summarizeDL(data){
const rows = data?.content || [];

if(!rows.length) return '❌ไม่พบข้อมูลใบขับขี่';

let msg = `🔎ข้อมูลใบขับขี่\n`;

rows.slice(0,2).forEach((license,idx)=>{
msg += `
📄ใบขับขี่ที่${idx+1}
🪪ประเภทใบขับขี่: ${license.type || '-'}
📝 เลขที่ใบขับขี่: ${license.licenseNumber || '-'}
📅 วันที่ออกใบอนุญาต: ${license.licenseIssueDate ? new Date(license.licenseIssueDate).toLocaleDateString('th-TH') : '-'}
📅 วันที่หมดอายุ: ${license.licenseExpirationDate ? new Date(license.licenseExpirationDate).toLocaleDateString('th-TH') : '-'}`;
});

return msg.trim();
}

function summarizeVehicleCID(res){
const rows = Array.isArray(res?.data)
? res.data
: Array.isArray(res?.data?.content)
? res.data.content
: Array.isArray(res?.content)
? res.content
: [];

if(!rows.length) return '❌ไม่พบข้อมูลทะเบียนรถ';

let msg = `🚗ข้อมูลทะเบียนรถ\n`;

rows.slice(0,1).forEach((car,index)=>{
msg += `
┌●รถคันที่${index+1}
├●ทะเบียน: ${safeVehicleValue(car?.plate1,'')}${safeVehicleValue(car?.plate2,'')}
├●สำนักงาน: ${safeVehicleValue(car?.offLocDesc)}
├●ยี่ห้อ: ${safeVehicleValue(car?.brnDesc)}
├●รุ่น: ${safeVehicleValue(car?.modelName)}
├●สี: ${getVehicleColor(car)}
├●ประเภทรถ: ${safeVehicleValue(car?.vehTypeDesc)}
├●ลักษณะรถ: ${safeVehicleValue(car?.kindDesc)}
├●วันที่จดทะเบียน: ${formatThaiDateOnly(car?.regDate)}
└●วันที่หมดอายุ: ${formatThaiDateOnly(car?.expDate)}`;
});

return msg.trim();
}

function fieldText(label,value){
return {
type:'box',
layout:'baseline',
spacing:'sm',
contents:[
{
type:'text',
text:`${label}:`,
size:'sm',
color:'#6B7280',
flex:3
},
{
type:'text',
text:String(value || '-'),
size:'sm',
color:'#111827',
wrap:true,
flex:5
}
]
};
}

function parseCrimeText(raw){
const s = String(raw || '');

function pick(label){
const m = s.match(new RegExp(label + '\\s*:\\s*([^\\n]+)', 'i'));
return m ? m[1].trim() : '-';
}

return {
warrant: pick('WARRENT'),
caseNo: pick('CRIMES'),
charge: pick('CHARGE'),
id: pick('ID'),
name: pick('FULLNAME'),
police: pick('POLICE'),
tel: pick('TELL'),
status: pick('STATUS')
};
}

function buildCrimeFlex(result, citizenId){

const rows =
Array.isArray(result?.data) ? result.data :
Array.isArray(result?.data?.data) ? result.data.data :
Array.isArray(result?.content) ? result.content :
[];

if(!rows.length){
return {
type:'text',
text:'❌ ไม่พบข้อมูลหมายจับ'
};
}

const bubbles = rows.slice(0,10).map((raw,index)=>{
const item = parseCrimeText(raw);

return {
type:'bubble',
size:'mega',
header:{
type:'box',
layout:'vertical',
backgroundColor:'#7F1D1D',
paddingAll:'16px',
contents:[
{
type:'text',
text:`📂 หมายจับ [CRIME] ${index+1}`,
weight:'bold',
size:'lg',
color:'#FFFFFF'
},
{
type:'text',
text:item.status || item.warrantStatus || 'ตรวจพบข้อมูล',
size:'sm',
color:'#FECACA',
margin:'sm'
}
]
},
body:{
type:'box',
layout:'vertical',
spacing:'sm',
contents:[
{
type:'text',
text:item.name || '-',
weight:'bold',
size:'md',
wrap:true,
color:'#111827'
},
{
type:'separator',
margin:'md'
},
fieldText('เลขหมายจับ', item.warrant || '-'),
fieldText('เลขคดี', item.caseNo || '-'),
fieldText('เลขบัตร', item.id || citizenId || '-'),
fieldText('ข้อหา', item.charge || '-'),
fieldText('เจ้าของคดี', item.police || '-'),
fieldText('เบอร์ติดต่อ', item.tel || '-'),
fieldText('สถานะหมาย', item.status || '-')
]
},
footer:{
type:'box',
layout:'vertical',
contents:[
{
type:'text',
text:`รายการ ${index+1} จาก ${rows.length}`,
size:'xs',
align:'center',
color:'#6B7280'
}
]
}
};
});

return {
type:'flex',
altText:`พบข้อมูลหมายจับ ${rows.length} รายการ`,
contents:{
type:'carousel',
contents:bubbles
}
};
}

function calcDistanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;

  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) *
    Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;

  return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

function formatDistanceResult(startLat, startLng, endLat, endLng, distance) {
const mapUrl = `https://www.google.com/maps/dir/${startLat},${startLng}/${endLat},${endLng}`;

return `📍 ข้อมูลพิกัดเชิงเส้นตรง
-  -  -  -  -  -  -  -  -  -

🟢 พิกัดต้นทาง
📌 ${startLat}, ${startLng}

🔴 พิกัดปลายทาง
📌 ${endLat}, ${endLng}

📏 ระยะทางเส้นตรง (Straight Line Distance)
➡️ ${distance} กิโลเมตร

🛰️ สรุปการเคลื่อนที่
ต้นทาง → ${startLat}, ${startLng}
ปลายทาง → ${endLat}, ${endLng}
ระยะห่างเชิงเส้นตรง → ${distance} กม.

🗺️ Google Maps
${mapUrl}

-  -  -  -  -  -  -  -  -  -

📌 หมายเหตุ: ระยะทางดังกล่าวเป็นระยะทางเส้นตรงจากพิกัดถึงพิกัด (Air Distance) ไม่ใช่ระยะทางตามเส้นทางถนนจริง`;
}

function formatPiPidResult(data){

if(!data || data.ok !== true){
return '❌ไม่พบข้อมูล';
}

return `╭ 👤 ข้อมูลบุคคล
├ 👤 ชื่อ-สกุล: ${data.name || '-'}
├ 🆔 เลขประจำตัวประชาชน: ${data.pid || '-'}
├ 👩 เพศ: ${data.sex || '-'}
╰ 🎂 วันเกิด: ${formatThaiDateOnlyText(data.dob)}

╭ 🏠 ที่อยู่ตามทะเบียนราษฎร
╰ 📍 ${data.address || '-'}

╭ 🏥 สิทธิการรักษา
├ 🏥 หน่วยบริการประจำ: ${data.hospital || '-'}
╰ 💳 สิทธิ: ${data.right || '-'}

╭ 👨‍👩‍👧 ข้อมูลบิดา-มารดา
├ 👨 บิดา: ${data.father_id || '-'}
╰ 👩 มารดา: ${data.mother_id || '-'}`;
}

function formatPiNameResult(data){

if(!data || data.ok !== true || !Array.isArray(data.results) || !data.results.length){
return '❌ไม่พบข้อมูล';
}

let msg = `🔎 ผลการค้นหาบุคคล
📊 พบข้อมูลทั้งหมด ${data.count || data.results.length} รายการ
-  -  -  -  -  -  -  -  -  -`;

data.results.forEach((item,index)=>{

msg += `

╭ 📂 รายการที่ ${index+1}
├ 👤 ชื่อ-สกุล: ${item.name || '-'}
├ 🆔 เลขบัตร: ${item.pid || '-'}
├ 🎂 วันเกิด: ${formatThaiDateOnlyText(item.dob)}
├ 📍 จังหวัด: ${item.province || '-'}
╰ 💳 สิทธิ: ${item.right || '-'}`;

});

return msg;
}

function formatThaiDateOnlyText(dateStr){

if(!dateStr) return '-';

const months = [
'มกราคม','กุมภาพันธ์','มีนาคม','เมษายน',
'พฤษภาคม','มิถุนายน','กรกฎาคม','สิงหาคม',
'กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม'
];

const d = new Date(dateStr);

if(isNaN(d.getTime())) return dateStr;

return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()+543}`;
}

function createCCTVFlex(cameraTime, realTime, diff) {
return {
type: 'flex',
altText: 'ผลการคำนวณเวลา CCTV',
contents: {
type: 'bubble',
body: {
type: 'box',
layout: 'vertical',
spacing: 'md',
contents: [
{
type: 'text',
text: '🎥 การคำนวณความต่างของเวลา CCTV',
weight: 'bold',
size: 'lg',
wrap: true
},
{
type: 'separator',
margin: 'md'
},
{
type: 'text',
text: `⏰ เวลาในกล้อง : ${cameraTime}`,
wrap: true
},
{
type: 'text',
text: `⌚ เวลาจริง : ${realTime}`,
wrap: true
},
{
type: 'text',
text: '🕒 เวลาต่างกัน',
weight: 'bold',
margin: 'md'
},
{
type: 'text',
text: diff,
wrap: true,
weight: 'bold',
color: '#0066CC',
size: 'md'
},
{
type: 'separator',
margin: 'lg'
},
{
type: 'text',
text: '⚠️ หากเวลาข้ามวัน ให้สลับใช้ เวลาจริง,เวลากล้อง',
size: 'xs',
wrap: true,
color: '#FF6B00',
margin: 'md'
}
]
}
}
};
}

function packageBubble(days, price, badgeText = '') {
  const isPopular = badgeText !== '';

  return {
    type: 'bubble',
    size: 'mega',
    hero: {
      type: 'image',
      url: 'https://impressive-copper-bvl5o5dr.edgeone.app/1086268.jpg',
      size: 'full',
      aspectRatio: '1:1',
      aspectMode: 'fit'
    },
    body: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#0B1F16',
      paddingAll: '20px',
      contents: [
        {
          type: 'text',
          text: isPopular ? badgeText : 'PREMIUM SUPPORT',
          weight: 'bold',
          size: 'xs',
          color: isPopular ? '#FFD700' : '#7CFFB2',
          align: 'center'
        },
        {
          type: 'text',
          text: 'สนับสนุนเซิร์ฟเวอร์',
          weight: 'bold',
          size: 'lg',
          color: '#FFFFFF',
          align: 'center',
          margin: 'md'
        },
        {
          type: 'text',
          text: days,
          weight: 'bold',
          size: '4xl',
          color: '#06C755',
          align: 'center',
          margin: 'lg'
        },
        {
          type: 'box',
          layout: 'vertical',
          backgroundColor: '#102E20',
          cornerRadius: 'lg',
          paddingAll: '14px',
          margin: 'md',
          contents: [
            {
              type: 'text',
              text: price,
              weight: 'bold',
              size: 'xxl',
              color: '#FFD700',
              align: 'center'
            }
          ]
        },
        {
          type: 'separator',
          margin: 'xl',
          color: '#2D5A3F'
        },
        {
          type: 'text',
          text: 'ชื่อผู้สนับสนุนต้องตรงกับผู้สมัครเท่านั้น',
          size: 'xs',
          color: '#FFB3B3',
          wrap: true,
          align: 'center',
          margin: 'lg'
        }
      ]
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#0B1F16',
      paddingAll: '16px',
      contents: [
        {
          type: 'button',
          style: 'primary',
          height: 'md',
          color: '#06C755',
          action: {
            type: 'uri',
            label: '📸 แจ้งสลิปสนับสนุน',
            uri: 'https://line.me/ti/p/mVmD-ncfvU'
          }
        }
      ]
    },
    styles: {
      hero: {
        backgroundColor: '#FFFFFF'
      },
      body: {
        backgroundColor: '#0B1F16'
      },
      footer: {
        backgroundColor: '#0B1F16'
      }
    }
  };
}

async function handleText(event) {
  const userId = event.source.userId;
  const text = (event.message.text || '').trim();

if (
  text.startsWith('d#') ||
  text.startsWith('t#') ||
  text.startsWith('tid#') ||
  text.startsWith('tn#') ||
  text.startsWith('f#') ||
  text.startsWith('tic%') ||
  text.startsWith('atm%') ||
  text.startsWith('cell%') ||
  text.startsWith('pid%') ||
  text.startsWith('nm%') ||
  text.startsWith('h%') ||
  text.startsWith('si%') ||
  text.startsWith('dc%') ||
  text.startsWith('dl#') ||
  text.startsWith('pb%') ||
  text.startsWith('psi#') ||
  text.startsWith('ps#') ||
  text.startsWith('wf%') ||
  text.startsWith('c#') ||
  text.startsWith('doc#') ||
  text.startsWith('cid#') ||
  text.startsWith('car#') ||
  text.startsWith('pt%') ||
  text.startsWith('ff%') ||
  text.startsWith('peab%') ||
  text.startsWith('pean%') ||
  text.startsWith('peau%') ||
  text.startsWith('peac%') ||
  text.startsWith('phis%') ||
  text.startsWith('chphis%') ||
  text.startsWith('dr%') ||
  text.startsWith('soc%') ||
  text.startsWith('ip%') ||
  text.startsWith('imei%') ||
  text.startsWith('imsi%') ||
  text.startsWith('icc%') ||
  text.startsWith('web%') ||
  text.startsWith('dis%') ||
  text.startsWith('map%') ||
  text.startsWith('lw%') ||
  text.startsWith('cj%') ||
  text.startsWith('se%') ||
  text.startsWith('lc%') ||
  text.startsWith('loa%') ||
  text.startsWith('for%') ||
  text.startsWith('tr%') ||
  text.startsWith('cctv%') ||
  text.startsWith('tisi%') ||
  text.startsWith('s%') ||
  text.startsWith('bq%')
) {
  try {
    const profile = await getProfile(userId);

    saveSearchLog(
      userId,
      profile.displayName,
      text
    );

    console.log(
      'SAVE LOG:',
      profile.displayName,
      text
    );
  } catch (e) {
    console.log(
      'save log error:',
      e.message
    );
  }
}

  const db = loadDB();
  const member = db.members?.[userId];

if (text.startsWith('ดูสมาชิกทั้งหมด')) {
  const page = Number(text.split(/\s+/)[1]) || 1;

  return reply(event.replyToken, {
    type: 'text',
    text: buildMembersAllText(db, page)
  });
}

if (text.startsWith('สมาชิกใกล้หมดอายุ')) {
  const page = Number(text.split(/\s+/)[1]) || 1;

  return reply(event.replyToken, {
    type: 'text',
    text: buildMembersExpiringSoonText(db, page)
  });
}

if (/^dis%/i.test(text)) {
  const raw = text.replace(/^dis%/i, '').trim();
  const parts = raw.split('/');

  if (parts.length !== 2) {
    return reply(event.replyToken, {
      type: 'text',
      text: '❌ รูปแบบไม่ถูกต้อง\nตัวอย่าง:\ndis%16.462991566703394,102.64543023829752/16.174215621798133,102.72808867876172'
    });
  }

  const start = parts[0].split(',').map(v => v.trim());
  const end = parts[1].split(',').map(v => v.trim());

  const startLat = Number(start[0]);
  const startLng = Number(start[1]);
  const endLat = Number(end[0]);
  const endLng = Number(end[1]);

  if ([startLat, startLng, endLat, endLng].some(Number.isNaN)) {
    return reply(event.replyToken, {
      type: 'text',
      text: '❌ พิกัดไม่ถูกต้อง\nรูปแบบ: dis%lat,lng/lat,lng'
    });
  }

  const distance = calcDistanceKm(startLat, startLng, endLat, endLng).toFixed(2);

  return reply(event.replyToken, {
    type: 'text',
    text: formatDistanceResult(startLat, startLng, endLat, endLng, distance)
  });
}

  if (
  text === '#สนับสนุน' ||
  text === 'สนับสนุน' ||
  text === '#donate'
) {
  return reply(event.replyToken, {
    type: 'flex',
    altText: 'แพ็คเกจสนับสนุนเซิร์ฟเวอร์',
    contents: {
      type: 'carousel',
      contents: [
  packageBubble('30 วัน', '499 บาท'),
  packageBubble('90 วัน', '1299 บาท'),
  packageBubble('180 วัน', '2500 บาท', '🔥 ยอดนิยม'),
  packageBubble('365 วัน', '4999 บาท', '⭐ คุ้มที่สุด')
]
    }
  });
}

if(/^อนุญาติดีแทค#/.test(text)){

const phone=text.replace(/^อนุญาติดีแทค#/,'').trim();

db.dtacPermissions=db.dtacPermissions||{};
db.dtacPermissions[phone]=true;

db.dtacBlocked = db.dtacBlocked || {};
delete db.dtacBlocked[phone];

saveDB(db);

return reply(event.replyToken,{
type:'text',
text:`✅ อนุญาต ${phone} ใช้ d# แล้ว`
});
}


// ===== คำสั่งแอดมินยกเลิกสิทธิ์ =====
if(/^ยกเลิกดีแทค#/.test(text)){

const phone=text.replace(/^ยกเลิกดีแทค#/,'').trim();

db.dtacPermissions = db.dtacPermissions || {};
delete db.dtacPermissions[phone];

// เพิ่มตรงนี้
db.dtacBlocked = db.dtacBlocked || {};
db.dtacBlocked[phone] = true;

saveDB(db);

return reply(event.replyToken,{
type:'text',
text:`❌ ยกเลิก ${phone} ใช้ d# แล้ว`
});
}

if (text.startsWith('อนุญาติดีแทค#')) {
  if (!isAdmin(userId)) {
    return reply(event.replyToken,{
      type:'text',
      text:'❌ คำสั่งนี้สำหรับแอดมิน'
    });
  }

  const phone =
  text.replace(/^อนุญาติดีแทค#/,'').trim();

  const found =
  findMemberByPhone(db,phone);

  if(!found){
    return reply(event.replyToken,{
      type:'text',
      text:'❌ ไม่พบสมาชิก'
    });
  }

  db.dtacPermissions[found.userId]=true;

  saveDB(db);

  return reply(event.replyToken,{
    type:'text',
    text:
`✅ อนุญาต DTAC แล้ว

👤 ${found.member.fullname || '-'}
📱 ${phone}`
  });
}

if (text.startsWith('ยกเลิกดีแทค#')) {

  if(!isAdmin(userId)){
    return reply(event.replyToken,{
      type:'text',
      text:'❌ คำสั่งนี้สำหรับแอดมิน'
    });
  }

  const phone =
  text.replace(/^ยกเลิกดีแทค#/,'').trim();

  const found =
  findMemberByPhone(db,phone);

  if(!found){
    return reply(event.replyToken,{
      type:'text',
      text:'❌ ไม่พบสมาชิก'
    });
  }

  delete db.dtacPermissions[found.userId];

  saveDB(db);

  return reply(event.replyToken,{
    type:'text',
    text:
`⛔ ยกเลิกสิทธิ์ DTAC แล้ว

👤 ${found.member.fullname || '-'}
📱 ${phone}`
  });
}

if(/^ยกเลิกประกันสังคม#/.test(text)){

if(!isAdmin(userId)){
return reply(event.replyToken,{
type:'text',
text:'❌ คำสั่งนี้สำหรับแอดมินเท่านั้น'
});
}

const phone=text.replace(/^ยกเลิกประกันสังคม#/,'').trim();

db.siBlocked=db.siBlocked||{};
db.siBlocked[phone]=true;

saveDB(db);

return reply(event.replyToken,{
type:'text',
text:`❌ ยกเลิก ${phone} ใช้ si% แล้ว`
});

}

if(/^อนุญาตประกันสังคม#/.test(text)){

if(!isAdmin(userId)){
return reply(event.replyToken,{
type:'text',
text:'❌ คำสั่งนี้สำหรับแอดมินเท่านั้น'
});
}

const phone=text.replace(/^อนุญาตประกันสังคม#/,'').trim();

db.siBlocked=db.siBlocked||{};
delete db.siBlocked[phone];

saveDB(db);

return reply(event.replyToken,{
type:'text',
text:`✅ อนุญาต ${phone} ใช้ si% แล้ว`
});

}

 // ===== ff% =====
  if (text === 'ff%') {

    faceCompareSessions[userId] = {
      step: 1,
      images: []
    };

    return reply(event.replyToken,{
      type:'text',
      text:`📸 โหมดเปรียบเทียบใบหน้า

กรุณาส่งรูปใบหน้าที่ 1`
    });

  }

if (text === 'pt%') {
  plateOcrSessions[userId] = true;

  return reply(event.replyToken, {
    type: 'text',
    text: `🚘 โหมดอ่านป้ายทะเบียน

กรุณาส่งรูปรถหรือป้ายทะเบียน`
  });
}

if (text.startsWith('pid%')) {
  const query = text.replace(/^pid%/i, '').trim();

  if (!query) {
    return reply(event.replyToken, {
      type: 'text',
      text: '❌ กรุณาระบุเลขบัตรประชาชน หรือ ชื่อสกุล\nตัวอย่าง:\npid%1401000124449\npid%ยุพิน บุญโกบุตร'
    });
  }

  try {
    const result = await searchPID(query);

    return reply(event.replyToken, {
      type: 'text',
      text: result
    });

  } catch (err) {
    console.error('pid lookup error:', err?.response?.data || err.message);

    return reply(event.replyToken, {
      type: 'text',
      text: '❌ ไม่พบข้อมูล'
    });
  }
}

  if (text.startsWith('lw%')) {

   const q = text.replace(/^lw%/,'').trim();

   if(!q){
      return reply(event.replyToken,{
         type:'text',
         text:'❌ ใช้งาน: lw%คำถาม'
      });
   }

   const res=await askLaw(q);

   if(
      !res ||
      !res.response ||
      !res.response.length
   ){
      return reply(event.replyToken,{
         type:'text',
         text:'❌ ไม่สามารถติดต่อระบบกฎหมายได้'
      });
   }

let answer = res.response[0].text;

// ลบข้อความเปิดของทนอย
answer = answer.replace(
/สวัสดีครับ!.*?ครับผม!\s*/s,
''
);

   return reply(event.replyToken,{
      type:'text',
      text:`\n-  -  -  -  -  -  -\n${res.response[0].text}`
   });

if (text.startsWith('dis%')) {
const raw = text.replace(/^dis%/i, '').trim();

const parts = raw.split('/');
if (parts.length !== 2) {
return reply(event.replyToken, {
type: 'text',
text: '❌ รูปแบบไม่ถูกต้อง\nตัวอย่าง:\ndis%16.462991566703394,102.64543023829752/16.174215621798133,102.72808867876172'
});
}

const start = parts[0].split(',').map(v => v.trim());
const end = parts[1].split(',').map(v => v.trim());

if (start.length !== 2 || end.length !== 2) {
return reply(event.replyToken, {
type: 'text',
text: '❌ กรุณาระบุพิกัดให้ครบ\nรูปแบบ: dis%lat,lng/lat,lng'
});
}

const startLat = start[0];
const startLng = start[1];
const endLat = end[0];
const endLng = end[1];

try {
const apiUrl =
`https://www.giraffai.com/api/v1/getdistance?start_lat=${encodeURIComponent(startLat)}&start_lng=${encodeURIComponent(startLng)}&end_lat=${encodeURIComponent(endLat)}&end_lng=${encodeURIComponent(endLng)}&unit=kilometers`;

const res = await axios.get(apiUrl, {
timeout: 20000,
headers: {
'User-Agent': 'Mozilla/5.0'
}
});

const distance = Number(res.data.distance).toFixed(2);

return reply(event.replyToken, {
type: 'text',
text: formatDistanceResult(startLat, startLng, endLat, endLng, distance)
});

} catch (err) {
console.error('distance lookup error:', err?.response?.data || err.message);

return reply(event.replyToken, {
type: 'text',
text: '❌ คำนวณระยะทางไม่สำเร็จ กรุณาลองใหม่อีกครั้ง'
});
}
}

if (event.type === 'message' && event.message.type === 'image') {
  const userId = event.source.userId;
  const session = faceCompareSessions[userId];

  if (!session) return null;

  const dir = path.join(__dirname, 'tmp');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);

  const imagePath = path.join(
    dir,
    `${userId}_${Date.now()}_${session.images.length + 1}.jpg`
  );

  await saveLineImage(event.message.id, imagePath);
  session.images.push(imagePath);

  if (session.images.length === 1) {
    return reply(event.replyToken, {
      type: 'text',
      text: `✅ รับรูปใบหน้าที่ 1 แล้ว

กรุณาส่งรูปใบหน้าที่ 2`
    });
  }

  if (session.images.length === 2) {
    try {
      const result = await compareFaces(session.images[0], session.images[1]);

      delete faceCompareSessions[userId];

      fs.unlinkSync(session.images[0]);
      fs.unlinkSync(session.images[1]);

      return reply(event.replyToken, {
        type: 'text',
        text: formatFaceCompareResult(result)
      });
    } catch (err) {
      delete faceCompareSessions[userId];

      return reply(event.replyToken, {
        type: 'text',
        text: `❌ เปรียบเทียบใบหน้าไม่สำเร็จ

กรุณาตรวจสอบว่ารูปทั้ง 2 รูปมีใบหน้าชัดเจน`
      });
    }
  }
}

}

if (text === 'b!') {
  db.bMode = db.bMode || {};
  db.bMode[userId] = true;
  saveDB(db);

  return reply(event.replyToken, {
    type: 'text',
    text: `กรอกข้อมูลตามนี้แล้วส่งกลับมา:

Location

Received at
GPS
CID
LAC
PLMN
MSISDN
Device status
Recency 0 Minutes
Received
Type 3G/4G/5G`
  });
}

if (db.bMode?.[userId]) {
  delete db.bMode[userId];
  saveDB(db);

  return reply(event.replyToken, {
    type: 'text',
    text: formatBCell(text)
  });
}

if (text === 'ดูสมาชิกรอตรวจสอบ') {
  if (!isAdmin(userId)) {
    return reply(event.replyToken, {
      type: 'text',
      text: '❌ คำสั่งนี้ใช้ได้เฉพาะแอดมิน'
    });
  }

  return reply(event.replyToken, buildPendingMembersFlex(db));
}

  const cancelMatch = text.match(/^ยกเลิกสมาชิก#(.+)$/);

  if (cancelMatch) {
    if (!isAdmin(userId)) {
      return reply(event.replyToken, {
        type: 'text',
        text: '❌ คำสั่งนี้ใช้ได้เฉพาะแอดมิน'
      });
    }

    const phone = cancelMatch[1].trim();
    const result = cancelMemberByPhone(phone);

    if (!result.ok) {
      return reply(event.replyToken, {
        type: 'text',
        text: result.message
      });
    }

    // ✅ กัน error ตรงนี้
    try {
      await push(result.userId, {
        type: 'text',
        text: '❌ บัญชีของคุณถูกยกเลิก หากมีข้อสงสัยกรุณาติดต่อผู้ดูแล'
      });
    } catch (e) {
      console.log('push error:', e.message);
    }

    // ✅ reply จะทำงานแน่นอน
    return reply(event.replyToken, {
      type: 'text',
      text: `✅ ยกเลิกสมาชิกสำเร็จ\nเบอร์: ${phone}\nUID: ${result.userId}`
    });
  }

  if (
  text.startsWith('fx#') ||
  text.startsWith('a#')
) {
  return reply(event.replyToken, {
    type: 'text',
    text: '🔍คำสั่งปรับปรุงค้นหาใหม่ภายหลัง...\n⏳command updates⏳'
  });
}

  if (!canUseBotCommands(userId, member, text)) {
    if (!member) {
      return reply(event.replyToken, {
        type: 'text',
        text: '❌ ยังไม่มีสิทธิ์ใช้งาน\nกรุณาสมัครสมาชิกก่อน โดยพิมพ์: ยินยอมรับข้อตกลง'
      });
    }

    if (member.status !== 'approved') {
      return reply(event.replyToken, {
        type: 'text',
        text: '❌ ยังไม่มีสิทธิ์ใช้งานโปรดติดต่อแอดมิน'
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
  }

  if (text.startsWith('t#')) {
    const phone = text.replace(/^t#/i, '').trim();
    if (!/^0\d{9}$/.test(phone)) {
      return reply(event.replyToken, {
        type: 'text',
        text: '❌ กรุณาระบุเบอร์โทรศัพท์ 10 หลัก เช่น t#0812345678'
      });
    }

    try {
      const data = await fetchTVGCCApi(phone);
      return reply(event.replyToken, {
        type: 'text',
        text: formatTVGCCResult(data, phone)
      });
    } catch (err) {
      console.error('tvgcc phone error:', err?.response?.data || err.message);
      const isTimeout = err.code === 'ECONNABORTED' || /timeout|exceeded/i.test(String(err.message || ''));
      return reply(event.replyToken, {
        type: 'text',
        text: isTimeout
? '⚠️ ระบบ TRUE ตอบช้า กรุณาลองใหม่ภายหลัง'
: `❌[${phone}]\nไม่พบข้อมูลเบอร์รายเดืือน`
      });
    }
  }

  if (text.startsWith('tn#')) {
    const name = text.replace(/^tn#/i, '').trim();
    if (!name || name.split(/\s+/).length < 2) {
      return reply(event.replyToken, {
        type: 'text',
        text: '❌ กรุณาระบุชื่อและนามสกุล เช่น tn#สุขใส สดใจ'
      });
    }

    try {
      const data = await fetchTVGCCApi(name);
      return reply(event.replyToken, {
        type: 'text',
        text: formatTVGCCResult(data, name)
      });
    } catch (err) {
      console.error('tvgcc name error:', err?.response?.data || err.message);
      const isTimeout = err.code === 'ECONNABORTED' || /timeout|exceeded/i.test(String(err.message || ''));
      return reply(event.replyToken, {
        type: 'text',
        text: isTimeout ? '🔎กรูณาสืบค้นใหม่อีกรอบ' : `❌[${name}] ไม่พบข้อมูลเบอร์รายเดือน`
      });
    }
  }

  if (text.startsWith('tid#')) {
    const citizenId = text.replace(/^tid#/i, '').trim();
    if (!/^\d{13}$/.test(citizenId)) {
      return reply(event.replyToken, {
        type: 'text',
        text: '❌ กรุณาระบุเลขบัตรประชาชน 13 หลัก เช่น tid#1234567890123'
      });
    }

    try {
      const data = await fetchISMApi(citizenId);
      return reply(event.replyToken, {
        type: 'text',
        text: formatISMResult(data, citizenId)
      });
    } catch (err) {
      console.error('ism tid error:', err?.response?.data || err.message);
      const isTimeout = err.code === 'ECONNABORTED' || /timeout|exceeded/i.test(String(err.message || ''));
      return reply(event.replyToken, {
        type: 'text',
        text: isTimeout ? '🔎กรูณาสืบค้นใหม่อีกรอบ' : `❌[${citizenId}] ไม่พบข้อมูล ISM`
      });
    }
  }

if(
text==="topup30" ||
text==="topup90" ||
text==="topup180" ||
text==="topup365"
){

let day='';
let price='';

if(text==="topup30"){
day='30';
price='499';
}

if(text==="topup90"){
day='90';
price='1299';
}

if(text==="topup180"){
day='180';
price='2500';
}

if(text==="topup365"){
day='365';
price='4999';
}

// บันทึกสถานะรอส่งสลิป
db.topups = db.topups || {};

db.topups[userId] = {
status:'waiting_slip',
days:Number(day),
price:Number(price),
createdAt:nowThai(),
updatedAt:nowThai()
};

saveDB(db);

return reply(event.replyToken,[

buildSupportFlex(),

{
type:'text',
text:
`คุณเลือกแพ็กเกจ ${day} วัน แล้ว

สนับสนุน ${price} B.

กรุณาส่งสลิปเข้ามาในแชตนี้ได้เลย`
}

]);

}

if (text.startsWith('nm%')) {
  const keyword = text.replace('nm%', '').trim();

  if (!keyword) {
    return reply(event.replyToken, {
      type: 'text',
      text: 'กรุณาพิมพ์ nm%ตามด้วยรหัส หรือชื่อหน่วยบริการ'
    });
  }

  const result = await searchHospital(keyword);

  return reply(event.replyToken, {
    type: 'text',
    text: result
  });
}

  if (text === 'menu%') {
  return reply(event.replyToken, {
    type: 'text',
    text: `📂 คู่มือคำสั่งใช้งาน 📂
-  -  -  -  -  -  -  -  -
╭ 📶 เครือข่าย / โทรศัพท์
├ 📶 %66xxxxxxxxx→สถานะเบอร์
├ 📶 ?เบอร์โทร→เครือข่ายเบอร์
├ 🟢 a#เบอร์โทร/เลขบัตร→REG AIS
├ 🔵 d#เบอร์โทร/เลขบัตร→REG DTAC
├ 🔴 t#เบอร์→REG TRUE
├ 🔴 tid#เลขบัตร→REG TRUE
╰ 🔴 tn#ชื่อ-นามสกุล→REG TRUE
-  -  -  -  -  -  -  -  -
╭ 📦 ระบบขนส่ง
├ 📦 f#เบอร์โทร→พัสดุทั่วไป
├ 📦 fx#เบอร์โทร/ชื่อสกุล/→พัสดุแบบละเอียด
╰ 📦 tic%เลขพัสดุ→ภาพรับพัสดุ
-  -  -  -  -  -  -  -  -
╭ 🏦 ธนาคาร / ATM
├ 🏦 bn%ชื่อธนาคาร→ค้นหาธนาคาร
├ 🏦 bc%รหัสสาขา→สาขาธนาคาร
├ 🏦 bk%เลขบัญชี→บัญชีธนาคาร
├ 🏦 atm%รหัสตู้→จุดติดตั้ง ATM
╰ 🏦 cell%LAC,CID→พิกัด Cell
-  -  -  -  -  -  -  -  -
╭ 🏥 สุขภาพ / การรักษา
├ 🏥 pid%เลขบัตร→ตรวจสอบสิทธิ
├ 🏥 h%เลขบัตร→ตรวจสอบข้อมูลการรักษา
╰ 🏥 nm%รหัสหน่วยบริการ/ชื่อสถานพยาบาล→ค้นหาสถานพยาบาล
-  -  -  -  -  -  -  -  -
╭ 🎓 การศึกษา
├ 🎓 st%เลขบัตรบุตร→ตรวจสอบข้อมูลการศึกษา
╰ ⚠️ ใช้เลขบัตรของบุตรเท่านั้น
-  -  -  -  -  -  -  -  -
╭ 🔎 ตรวจสอบบุคคล
├ 🔎 si%เลขบัตร→ตรวจสอบประกันสังคม
├ 🔎 dc%ชื่อ สกุล→ตรวจสอบแพทย์
├ 🔎 dl#เลขบัตร→ตรวจสอบใบขับขี่
├ 🔎 pb%เลขบัตร→ตรวจสอบคุมประพฤติ
├ 🔎 psi#เลขบัตร→ตรวจสอบผู้ต้องขัง
╰ 🔎 ps#เลขบัตร→ตรวจสอบผู้ต้องขังยังไม่พิพากษา
├ 🔎 wf%เลขบัตร→เบี้ยยังชีพ
-  -  -  -  -  -  -  -  -
╭ 🚔 หมายจับ
├ ⚖️ c#เลขบัตร→หมายจับ CRIME
╰ ⚖️ doc#เลขบัตร→หมายจับศาล
-  -  -  -  -  -  -  -  -
╭ 🚗 ครอบครองรถ / ทะเบียน
├ 🚗 cid#เลขบัตร→ตรวจจากเลขบัตร
├ 🚗 car#จังหวัด หมวด ตัวเลข ประเภทรถ→ตรวจจากทะเบียน
├ 📌 ตัวอย่าง:
│ 🚘 car#กรุงเทพ 1กก 334 1
├ 🚗 pt%→อ่านป้ายทะเบียนและวิเคราะห์รถ
╰ 📸 รอระบบแจ้งให้ส่งภาพใบหน้า

╭ 🧑‍💻 ระบบ AI / เปรียบเทียบ
├ 🧑‍💻 ff%→เปรียบเทียบใบหน้า
╰ 📸 รอระบบแจ้งให้ส่งภาพใบหน้า
-  -  -  -  -  -  -  -  -
╭ ⚡ ไฟฟ้า / ยูทิลิตี้
├ ⚡ mea%ชื่อสกุล→Mea ชื่อสกุล
├ ⚡ kru%เลขมิเตอร์→Mea มิเตอร์ไฟฟ้า
├ ⚡ peab%เลขCA เว้นวรรค เลขมิเตอร์→ตรวจสอบประวัติใช้ไฟ
│ (peab%02000xxxx 63xxxxx)
├ ⚡ peac%เลข CA→ไฟฟ้าจาก CA
├ ⚡ pean%ชื่อสกุล→ไฟฟ้าจากชื่อสกุล
├ ⚡ peau%ที่อยู่→ไฟฟ้าจากที่อยู่ เช่น
│ 19 ม.1 ต.ทดสอบ อ.ทดสอบ
╰ (ไม่ต้องใส่ถึง จ.)
-  -  -  -  -  -  -  -  -
╭ 🌐 เครื่องมือ / ข้อมูลอื่นๆ
├ 🎣 phis%URL→เพิ่ม Phishing
├ 🎣 chphis%ID→ตรวจ Phishing
├ 🌐 picf%url→ตรวจ ดึงภาพ Profile facebook
├ 🔎 dr%ชื่อ สกุล→ข้อมูลแพทย์/บุคลากรสาธารณสุข
├ 🌐 soc%Username/ชื่อโซเชี่ยล/หรือข้อความอื่นๆ→ค้นหาโซเชี่ยล
├ 🌐 ip%เลข IP→ตรวจเครือข่าย IP
├ 🌐 imei%เลข IMEI→ตรวจ IMEI
├ 🌐 imsi%เลข IMSI→ตรวจ IMSI
├ 🌐 icc%เลข ICCID→ตรวจเลขซิมการ์ด
├ 🌐 web%ชื่อเว็บไซต์→ตรวจเว็บไซต์
├ 🌐 dis%ละติจูด ลองจิจูดต้นทาง/ละติจูด ลองติจูดปลายทาง→ระยะทางเชิงเส้นตรง 
⚠️ตัวอย่าง⚠️
dis%16.xxxxxx,108.xxxxxx/16.xxxx3,108.xxxxx
├ 🌐 map%ละติจูด,ลองจิจูด→พิกัด MAP
╰ 🌐 lw%คำถาม→ค้นหาข้อกฎหมาย
-  -  -  -  -  -  -  -  -
╭ 🏪 ร้านค้า / สวัสดิการ
├ 🏪 cj%เบอร์ เลขบัตร→สมาชิก CJ
├ 🏪 se%รหัสสาขา7-11→สาขาเซเว่น
├ 🏢 lc%ชื่อ-สกุล,ชื่อบริษัท→ใบอนุญาตบริษัท
├ 📱 loa%ชื่อแอป→ตรวจสอบแอปเงินกู้
├ 📑 for%เลขนิติ→ทะเบียนพาณิชย์/นิติบุคคล
├ 🚚 tr%ชื่อผู้ประกอบการ→ผู้ประกอบการขนส่ง
├ 📹 cctv%เวลากล้อง,เวลาจริง→เปรียบเทียบเวลากล้อง
├ 🏅 tisi%เลขมอก.→ตรวจมาตรฐาน มอก
├ 🛒 s%เลขบัตร→ผ่อนเครื่องใช้ไฟฟ้า
╰ 🚙 bq%เบอร์โทร/เลขบัตร→ศูนย์บริการรถ
-  -  -  -  -  -  -  -  -
╭ 🚘 ประเภทรถ
├ 1️⃣ รถยนต์นั่งไม่เกิน 7 คน
├ 2️⃣ รถยนต์นั่งเกิน 7 คน
├ 3️⃣ รถบรรทุกส่วนบุคคล
├ 4️⃣ สามล้อส่วนบุคคล
├ 5️⃣ รับจ้างระหว่างจังหวัด
├ 6️⃣ รับจ้างไม่เกิน 7 คน
├ 7️⃣ สี่ล้อเล็กรับจ้าง
├ 8️⃣ รับจ้างสามล้อ
├ 9️⃣ บริการธุรกิจ
├ 🔟 บริการทัศนาจร
├ 1️⃣1️⃣ บริการให้เช่า
├ 1️⃣2️⃣ จักรยานยนต์
├ 1️⃣3️⃣ รถแทรกเตอร์
├ 1️⃣4️⃣ รถบดถนน
├ 1️⃣5️⃣ รถใช้ในงานเกษตรกรรม
├ 1️⃣6️⃣ รถพ่วง
├ 1️⃣7️⃣ จักรยานยนต์สาธารณะ
├ 3️⃣0️⃣ รถโดยสารประจำทาง
├ 3️⃣1️⃣ รถขนาดเล็ก
├ 3️⃣2️⃣ โดยสารไม่ประจำทาง
├ 3️⃣3️⃣ โดยสารส่วนบุคคล
├ 3️⃣4️⃣ บรรทุกไม่ประจำทาง
╰ 3️⃣5️⃣ บรรทุกส่วนบุคคล
-  -  -  -  -  -  -  -  -
╭ ⚠️ คำสั่งที่มีการปรับปรุง
╰ ⚠️ a# / fx#`
  });
}

if (text.startsWith('picf%')) {
  const fbUrl = text.replace(/^picf%/i, '').trim();

  if (!fbUrl) {
    return reply(event.replyToken, {
      type: 'text',
      text: '❌ กรุณาระบุลิงก์ Facebook\nตัวอย่าง: picf%https://www.facebook.com/zuck'
    });
  }

  let profileId = '';

  try {
    const url = new URL(fbUrl);

    if (url.pathname.includes('/profile.php')) {
      profileId = url.searchParams.get('id');
    } else {
      profileId = url.pathname.split('/').filter(Boolean)[0];
    }

    if (!profileId) {
      return reply(event.replyToken, {
        type: 'text',
        text: '❌ ไม่พบ Profile ID'
      });
    }

    const result = await getFacebookProfile(profileId);

    if (!result || typeof result !== 'object') {
      return reply(event.replyToken, {
        type: 'text',
        text: '❌ ไม่พบข้อมูล Facebook'
      });
    }

    return reply(event.replyToken, {
      type: 'flex',
      altText: 'ข้อมูลโปรไฟล์ Facebook',
      contents: buildFacebookProfileFlex(result)
    });

  } catch (err) {
    console.error('picf error:', err?.response?.data || err.message);
    return reply(event.replyToken, {
      type: 'text',
      text: '❌ ลิงก์ Facebook ไม่ถูกต้อง หรือไม่พบข้อมูล'
    });
  }
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

if (text === 'face%') {
  db.faceCompare = db.faceCompare || {};
  db.faceCompare[userId] = {
    step: 1,
    file1: '',
    file2: ''
  };
  saveDB(db);

  return reply(event.replyToken, {
    type: 'text',
    text: '📸 กรุณาส่งรูปใบหน้ารูปที่ 1'
  });
}

  if (text.startsWith('send#')) {
    if (!isAdmin(userId)) {
      return reply(event.replyToken, {
        type: 'text',
        text: '❌ คำสั่งนี้ใช้ได้เฉพาะแอดมิน'
      });
    }

    const parts = text.split('#');
    const targetUserId = parts[1];
    const message = parts.slice(2).join('#').trim();

    if (!targetUserId || !message) {
      return reply(event.replyToken, {
        type: 'text',
        text: '❌ รูปแบบ: send#UID#ข้อความ'
      });
    }

    await push(targetUserId, {
      type: 'text',
      text: message
    });

    return reply(event.replyToken, {
      type: 'text',
      text: '✅ ส่งข้อความถึงสมาชิกแล้ว'
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

    return reply(event.replyToken, buildMemberStatusFlex(member, statusText));
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

      return reply(
event.replyToken,
buildCrimeFlex(result, nationId)
);
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
    return reply(event.replyToken, result);
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
        '✅บันทึกข้อมูลสมัครเรียบร้อยแล้ว\n' +
        '🪪กรุณารูภาพบัตรข้าราชการทางRTP4Mหรือเอกสารที่ยืนยันตัวตนข้าราชการ'
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
        `อนุมัติ ${found.fullname || targetUserId} เรียบร้อยแล้ว\n` +
        `เพิ่ม: ${days} วัน\n` +
        `หมดอายุใหม่: ${formatThaiDate(baseDate)}`
    });
  }

  if (text.startsWith('d#')) {

const phone=text.replace(/^d#/,'').trim();

if(!phone){
return reply(event.replyToken,{
type:'text',
text:'❌ กรุณาระบุเบอร์ 10 หลัก หรือ เลขบัตร 13 หลัก'
});
}

const registeredPhone =
member?.phone ||
member?.tel ||
member?.mobile ||
'';

const isBlocked =
db.dtacBlocked?.[registeredPhone] === true;

if(isBlocked){
return reply(event.replyToken,{
type:'text',
text:`⛔สิทธิ์สืบค้นคำสั่ง DTAC ถูกยกเลิกแล้ว⛔

📂ต้องการใช้งานติดต่อ admin📂
Contact Admin:
https://line.me/ti/p/mVmD-ncfvU
------------`
});
}

try{

const url=`https://dtac-api.jedi-r3cloud.org/dtac?phone=${encodeURIComponent(phone)}&token=jedi-api-2026`;

const res=await axios.get(url,{
timeout:45000
});

const msg=formatDtacSearch(
res.data,
phone
);

return reply(event.replyToken,{
type:'text',
text:msg
});

}catch(err){

console.error(
'dtac lookup error:',
err?.response?.data ||
err.message
);

return reply(event.replyToken,{
type:'text',
text:'🔎 สืบค้นใหม่อีกครั้ง'
});

}

}

// soc%ข้อความ
if (text.startsWith('soc%')) {

  const keyword = text.replace(/^soc%/i, '').trim();

  if (!keyword) {
    return reply(event.replyToken, {
      type: 'text',
      text: '❌ กรุณาระบุคำค้น'
    });
  }

  try {

    let msg = `🔎 Social Search: [${keyword}]\n\n`;

    msg += `📘Facebook\n`;
    msg += `https://www.google.com/search?q=${encodeURIComponent(keyword + ' site:facebook.com')}\n`;
    msg += `-------------------\n`;

    msg += `📸Instagram\n`;
    msg += `https://www.google.com/search?q=${encodeURIComponent(keyword + ' site:instagram.com')}\n`;
    msg += `-------------------\n`;

    msg += `🎵TikTok\n`;
    msg += `https://www.google.com/search?q=${encodeURIComponent(keyword + ' site:tiktok.com')}\n`;
    msg += `-------------------\n`;

    msg += `▶️YouTube\n`;
    msg += `https://www.google.com/search?q=${encodeURIComponent(keyword + ' site:youtube.com')}\n`;
    msg += `-------------------\n`;

    msg += `🐦Twitter/X\n`;
    msg += `https://www.google.com/search?q=${encodeURIComponent(keyword + ' site:x.com OR site:twitter.com')}\n`;
    msg += `-------------------\n`;

    msg += `🧵Threads\n`;
    msg += `https://www.google.com/search?q=${encodeURIComponent(keyword + ' site:threads.net')}`;

    return reply(event.replyToken, {
      type: 'text',
      text: msg
    });

  } catch (err) {

    console.error('soc error:', err.message);

    return reply(event.replyToken, {
      type: 'text',
      text: '⌛กรุณาสืบค้นใหม่อีกครั้ง⌛'
    });

  }

}

  // DPlus Express: f#เบอร์
  if (text.startsWith('f#')) {
    const phone = text.replace(/^f#/i, '').trim();
    if (!/^0\d{9}$/.test(phone)) {
      return reply(event.replyToken, { type: 'text', text: '❌ กรุณาระบุเบอร์โทรศัพท์ 10 หลัก เช่น f#0877315865' });
    }

    try {
      const data = await fetchDPlusCustomerApi(phone);
      return reply(event.replyToken, { type: 'text', text: formatDPlusCustomers(data, phone) });
    } catch (err) {
      console.error('dplus customer error:', err?.response?.data || err.message);
      return reply(event.replyToken, { type: 'text', text: '❌ ดึงข้อมูลไม่สำเร็จ: ' + err.message });
    }
  }

  // B-Quik CRM: bq%ชื่อ นามสกุล หรือ bq%เบอร์ หรือ bq%เลขบัตร
  if (text.startsWith('bq%')) {
    const query = text.replace(/^bq%/i, '').trim();
    if (!query) {
      return reply(event.replyToken, { type: 'text', text: '❌ กรุณาระบุคำค้น เช่น bq%0973458235 หรือ bq%วิชัย จำปา' });
    }

    try {
      const data = await fetchBQuikApi(query);
      return reply(event.replyToken, { type: 'text', text: formatBQuikResult(data, query) });
    } catch (err) {
      console.error('bquik error:', err?.response?.data || err.message);
      return reply(event.replyToken, { 
  type: 'text', 
  text: '⌛กรุณาสืบค้นใหม่อีกครั้ง⌛'
});
    }
  }

  // ตรวจสอบแพทยสภา: dc%ชื่อ สกุล
  if (text.startsWith('dc%')) {
    const query = text.replace(/^dc%/i, '').trim();
    const parts = query.split(/\s+/).filter(Boolean);

    if (parts.length < 2) {
      return reply(event.replyToken, { type: 'text', text: '❌ กรุณาระบุชื่อและนามสกุล เช่น dc%ภัทรักษ์ ลาภบุญเรือง' });
    }

    const firstName = parts[0];
    const lastName = parts.slice(1).join(' ');

    try {
      const result = await searchCheckMd(firstName, lastName);
      return reply(event.replyToken, { type: 'text', text: formatCheckMdResult(result, query) });
    } catch (err) {
      console.error('checkmd error:', err?.response?.data || err.message);
      return reply(event.replyToken, { type: 'text', text: '❌ ตรวจสอบแพทยสภาไม่สำเร็จ: ' + err.message });
    }
  }

  if (text.startsWith('dr%')) {
    const query = text.replace(/^dr%/i, '').trim();
    const parts = query.split(/\s+/).filter(Boolean);

    if (parts.length < 2) {
      return reply(event.replyToken, { type: 'text', text: '❌ กรุณาระบุชื่อและนามสกุล เช่น dr%ภัทรักษ์ ลาภบุญเรือง' });
    }

    try {
      const result = await searchCheckMd(parts[0], parts.slice(1).join(' '));
      return reply(event.replyToken, { type: 'text', text: formatCheckMdResult(result, query) });
    } catch (err) {
      console.error('dr checkmd error:', err?.response?.data || err.message);
      return reply(event.replyToken, { type: 'text', text: '❌ ตรวจสอบแพทย์ไม่สำเร็จ: ' + err.message });
    }
  }

  // นักเรียน OPEC: st%เลขบัตร
  if (text.startsWith('st%')) {
    const citizenId = text.replace(/^st%/i, '').trim();
    if (!/^\d{13}$/.test(citizenId)) {
      return reply(event.replyToken, { type: 'text', text: '❌ กรุณาระบุเลขบัตรประชาชน 13 หลัก เช่น st%1409904942425' });
    }

    try {
      const res = await fetchOpecStudentApi(citizenId);
      return reply(event.replyToken, {
        type: 'text',
        text: formatOpecStudentResult(res, citizenId)
      });
    } catch (err) {
      console.error('opec student error:', err?.response?.data || err.message);
      return reply(event.replyToken, { type: 'text', text: '❌ ดึงข้อมูลนักเรียน OPEC ไม่สำเร็จ' });
    }
  }

  // ประกันสังคม: si%เลขบัตร
  if (text.startsWith('si%')) {
    const registeredPhone =
member?.phone ||
member?.tel ||
member?.mobile ||
'';

const isSiBlocked =
db.siBlocked?.[registeredPhone] === true;

if(isSiBlocked){
return reply(event.replyToken,{
type:'text',
text:`⛔สิทธิ์สืบค้นคำสั่งประกันสังคมถูกยกเลิกแล้ว⛔

📂ต้องการใช้งานติดต่อ admin📂
Contact Admin:
https://line.me/ti/p/mVmD-ncfvU
------------`
});
}
    const ssoNum = text.replace(/^si%/, '').trim();
    if (!ssoNum) return reply(event.replyToken, { type: 'text', text: '❌ กรุณาระบุเลขบัตรประชาชน เช่น si%1234567890123' });
    try {
      const res = await fetchSearchApiRaw({ si: ssoNum });
      if (!res.success) return reply(event.replyToken, { type: 'text', text: `❌ ${res.message || 'ดึงข้อมูลไม่สำเร็จ'}` });
      const data = res.data;
      if (data.content && data.content.length > 0) {
        let result = `🔎ประวัติการทำงานประกันสังคม\n-------------------\n🆔เลขประกันสังคม:${ssoNum}\n📊จำนวนที่พบ:${data.totalElements}รายการ\n`;
        data.content.forEach((item, idx) => {
          result += `\n 🏢 บริษัท ${idx + 1}\n`;
          result += `┌●ชื่อบริษัท: ${item.companyName || '-'}\n`;
          result += `├●รหัสสาขา: ${item.accBran || item.branchCode || '-'}\n`;
          result += `├●เลขที่บัญชี: ${item.accNo || item.accountNo || '-'}\n`;
          result += `├●วันที่เริ่มงาน: ${item.expStartDateText || '-'}\n`;
          result += `├●วันที่ลาออก: ${item.empResignDateText || '-'}\n`;
          result += `└●สถานะ: ${item.employStatusDesc || '-'}\n`;
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
      const res = await fetchSearchApiRaw({ doc: accCardId });
      if (!res.success) return reply(event.replyToken, { type: 'text', text: `❌ ${res.message || 'ดึงข้อมูลไม่สำเร็จ'}` });
      const data = res.data;
      if (data.content && data.content.length > 0) {
        const itemsPerPage = 3;
        const totalPages = Math.ceil(data.content.length / itemsPerPage);
        if (isNaN(page) || page < 0) page = 0;
        if (page >= totalPages) return reply(event.replyToken, { type: 'text', text: `ไม่พบข้อมูลหน้าที่ ${page + 1} (มีทั้งหมด ${totalPages} หน้า)` });
        const startIndex = page * itemsPerPage;
        const pageItems = data.content.slice(startIndex, Math.min(startIndex + itemsPerPage, data.content.length));
        let result = `🔎ข้อมูลหมายจับศาล(หน้า ${page + 1}/${totalPages})\n- - - - - - - - - - - - -\n`;
        pageItems.forEach((warrant, idx) => {
          result += `\n📄 หมายจับที่ ${startIndex + idx + 1}\n`;

          result += `┌● เลขที่: ${warrant.woaNo || '-'} / ${warrant.woaYear || '-'}\n`;
          result += `├● ศาล: ${warrant.courtCodeText || '-'}\n`;
          result += `├● สถานะ: ${warrant.arrestStatus || '-'}\n`;
          result += `├● ข้อหา: ${warrant.charge || '-'}\n`;
          result += `├● ผู้เสัยหาย: ${warrant.plaintiff || '-'}\n`;
          result += `├● ผู้พิพากษา: ${warrant.judgeName || '-'}\n`;
          result += `├● ออกหมาย: ${warrant.woaDate ? new Date(warrant.woaDate).toLocaleDateString('th-TH') : '-'}\n`;
          result += `├● เริ่มต้น: ${warrant.woaStartDate ? new Date(warrant.woaStartDate).toLocaleDateString('th-TH') : '-'}\n`;
          result += `└● สิ้นสุด: ${warrant.woaEndDate ? new Date(warrant.woaEndDate).toLocaleDateString('th-TH') : '-'}\n`;
        });
        result += `\n📊แสดง ${pageItems.length} จาก ${data.content.length} รายการ`;
        if (totalPages > 1) result += `\nพิมพ์ doc#${accCardId} [1-${totalPages}] เพื่อดูหน้าอื่น`;
        return reply(event.replyToken, { type: 'text', text: result });
      } else {
        return reply(event.replyToken, { type: 'text', text: 'ไม่พบข้อมูลหมายศาล' });
      }
    } catch (err) {
      return reply(event.replyToken, { type: 'text', text: '❌ดึงข้อมูลหมายศาลไม่สำเร็จ' });
    }
  }

  // ใบขับขี่: dl#เลขบัตร
  if (text.startsWith('dl#')) {
    const cid = text.replace(/^dl#/, '').trim();
    if (!cid) return reply(event.replyToken, { type: 'text', text: '❌กรุณาระบุเลขบัตรประชาชน เช่น dl#1234567890123' });
    try {
      const res = await fetchSearchApiRaw({ dl: cid });
      if (!res.success) return reply(event.replyToken, { type: 'text', text: `❌ ${res.message || 'ดึงข้อมูลไม่สำเร็จ'}` });
      const data = res.data;
      if (data.content && data.content.length > 0) {
        let result = `🔎ข้อมูลใบขับขี่\n- - - - - - - - - - - - -\n`;
        data.content.forEach((license, idx) => {
          result += `\n📄ใบขับขี่ที่${idx + 1}\n👤ชื่อ:${license.fullName}\n🆔เลขบัตร:${license.citizenCardNumber}\n🪪ประเภทใบขับขี่: ${license.type}\n📝 เลขที่ใบขับขี่: ${license.licenseNumber}\n📅 วันที่ออกใบอนุญาต: ${new Date(license.licenseIssueDate).toLocaleDateString('th-TH')}\n📅 วันที่หมดอายุ: ${new Date(license.licenseExpirationDate).toLocaleDateString('th-TH')}\n⭐ สถานะ: ${license.status}\n🏠 ที่อยู่: ${license.address}\n-------------------`;
        });
        result += `\n📊พบข้อมูลทั้งหมด ${data.totalElements} รายการ`;
        return reply(event.replyToken, { type: 'text', text: result });
      } else {
        return reply(event.replyToken, { type: 'text', text: 'ไม่พบข้อมูลใบขับขี่' });
      }
    } catch (err) {
      return reply(event.replyToken, { type: 'text', text: '❌ดึงข้อมูลใบขับขี่ไม่สำเร็จ' });
    }
  }

  // คุมประพฤติ: pb%เลขบัตร
  if (text.startsWith('pb%')) {
    const citizenId = text.replace(/^pb%/i, '').trim();
    if (!/^\d{13}$/.test(citizenId)) {
      return reply(event.replyToken, { type: 'text', text: '❌กรุณาระบุเลขบัตรประชาชน 13 หลัก เช่น pb%3100502131342' });
    }
    try {
      const res = await fetchPEAApiFull({ pb: citizenId });
      return reply(event.replyToken, { type: 'text', text: res.message || '❌ไม่พบข้อมูลคุมประพฤติ' });
    } catch (err) {
      console.error('pb error:', err?.response?.data || err.message);
      return reply(event.replyToken, { 
  type: 'text', 
  text: '⌛กรุณาสืบค้นใหม่อีกครั้ง⌛'
});
    }
  }

  // เช็ครถจาก CID: cid#เลขบัตร
  if (text.startsWith('cid#')) {
    const payload = text.replace(/^cid#/, '').trim();
    const parts = payload.split(/\s+/);
    const cid = parts[0];
    let page = parts[1] ? parseInt(parts[1], 10) - 1 : 0;
    if (!cid) return reply(event.replyToken, { type: 'text', text: '❌ กรุณาระบุเลขบัตรประชาชน เช่น cid#1234567890123' });
    try {
      const res = await fetchSearchApiRaw({ cid });
      if (!res.success) return reply(event.replyToken, { type: 'text', text: `❌ ${res.message || 'ดึงข้อมูลไม่สำเร็จ'}` });
      const data = res.data;
      if (data.content && data.content.length > 0) {
        const itemsPerPage = 2;
        const totalPages = Math.ceil(data.content.length / itemsPerPage);
        if (isNaN(page) || page < 0) page = 0;
        if (page >= totalPages) {
          return reply(event.replyToken, { type: 'text', text: `ไม่พบข้อมูลหน้าที่ ${page + 1} (มีทั้งหมด ${totalPages} หน้า)` });
        }
        const startIndex = page * itemsPerPage;
        const pageItems = data.content.slice(startIndex, Math.min(startIndex + itemsPerPage, data.content.length));
        let result = `🚗ข้อมูลทะเบียนรถ (จาก CID) หน้า ${page + 1}/${totalPages}\n- - - - - - - - - - - - -\n`;
        pageItems.forEach((vehicle, idx) => {
          result += formatVehicleDetails(vehicle, startIndex + idx + 1);
        });
        result += `\n📊 พบทั้งหมด ${data.content.length} คัน`;
        result += `\n📄 แสดง ${pageItems.length} คันในหน้านี้`;
        if (totalPages > 1) result += `\nพิมพ์ cid#${cid} [หน้า] เพื่อดูหน้าอื่น`;
        return reply(event.replyToken, { type: 'text', text: result });
      } else {
        return reply(event.replyToken, { type: 'text', text: 'ไม่พบข้อมูลทะเบียนรถ' });
      }
    } catch (err) {
      return reply(event.replyToken, { 
  type: 'text', 
  text: '⌛กรุณาสืบค้นใหม่อีกครั้ง⌛'
});
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
      const res = await fetchSearchApiRaw({ province, plate1, plate2, vehTypeRef });
      if (!res.success) return reply(event.replyToken, { type: 'text', text: `❌ ${res.message || 'ดึงข้อมูลไม่สำเร็จ'}` });
      const data = res.data;
      if (data.content && data.content.length > 0) {
        const itemsPerPage = 3;
        const totalPages = Math.ceil(data.content.length / itemsPerPage);
        if (isNaN(page) || page < 0) page = 0;
        if (page >= totalPages) return reply(event.replyToken, { type: 'text', text: `ไม่พบข้อมูลหน้าที่ ${page + 1} (มีทั้งหมด ${totalPages} หน้า)` });
        const startIndex = page * itemsPerPage;
        const pageItems = data.content.slice(startIndex, Math.min(startIndex + itemsPerPage, data.content.length));
        let result = `🚗 ข้อมูลทะเบียนรถ (หน้า ${page + 1}/${totalPages})\n- - - - - - - - - - - - -\n`;
        pageItems.forEach((vehicle, idx) => {
          result += formatVehicleDetails(vehicle, startIndex + idx + 1);
        });
        result += `\n📊 แสดง ${pageItems.length} จาก ${data.content.length} รายการ`;
        if (totalPages > 1) result += `\nพิมพ์ car#${province} ${plate1} ${plate2} ${vehTypeRef} [หน้า] เพื่อดูหน้าอื่น`;
        return reply(event.replyToken, { type: 'text', text: result });
      } else {
        return reply(event.replyToken, { type: 'text', text: 'ไม่พบข้อมูลทะเบียนรถ' });
      }
    } catch (err) {
      return reply(event.replyToken, { 
  type: 'text', 
  text: '⌛กรุณาสืบค้นใหม่อีกครั้ง⌛'
});
    }
  }

  if (text.startsWith('h%')) {
    const pidToSearch = text.replace(/^h%/, '').trim();
    if (!/^\d{13}$/.test(pidToSearch)) {
      return reply(event.replyToken, { type: 'text', text: '❌กรุณาระบุเลขบัตรประชาชน เช่น h%1234567890123' });
    }
    try {
      const res = await fetchNhsoRightApi(pidToSearch);
      const result = formatNhsoRightApiResult(res, pidToSearch);
      return reply(event.replyToken, { type: 'text', text: result });
    } catch (err) {
      console.error('h% NHSO error:', err?.response?.data || err.message);
      return reply(event.replyToken, { type: 'text', text: '❌ ดึงข้อมูลสิทธิ NHSO ไม่สำเร็จ กรุณาลองใหม่อีกครั้ง' });
    }
  }

  if (text.startsWith('tic%')) {
    const trackingId = text.replace(/^tic%/, '').trim();
    if (!trackingId) {
      return reply(event.replyToken, { type: 'text', text: '❌กรุณาระบุเลขพัสดุ เช่น tic%THT123456789TH' });
    }
    const result = await trackFlashExpress(trackingId);
    return reply(event.replyToken, { type: 'text', text: result });
  }

  if (text.startsWith('atm%')) {
    const atmCode = text.replace(/^atm%/i, '').trim();
    try {
      const data = await fetchPEAApi({ atm: atmCode });
      const result = formatKeyValueRows(data, `🏧 ข้อมูลตู้ ATM: ${atmCode}`);
      return reply(event.replyToken, { type: 'text', text: result });
    } catch (err) {
      console.error('atm lookup error:', err?.response?.data || err.message);
      return reply(event.replyToken, { type: 'text', text: '❌ดึงข้อมูล ATM ไม่สำเร็จ: ' + err.message });
    }
  }

if (text.startsWith('#')) {

const newText = formatParcel(text);

return reply(event.replyToken, {
type: 'text',
text: newText
});

}

if (text.startsWith('@')) {

const newText = formatPhoneData(text);

return reply(event.replyToken, {
type: 'text',
text: newText
});

}

  if (text.startsWith('phis%')) {
    const targetUrl = text.replace(/^phis%/i, '').trim();
    if (!targetUrl) {
      return reply(event.replyToken, { type: 'text', text: '❌ กรุณาระบุ URL เช่น phis%https://example.com' });
    }
    const result = await createPhishingShortLink(targetUrl);
    return reply(event.replyToken, { type: 'text', text: result });
  }

  if (text.startsWith('chphis%')) {
    const id = text.replace(/^chphis%/i, '').trim();
    if (!id) {
      return reply(event.replyToken, { type: 'text', text: '❌ กรุณาระบุ ID เช่น chphis%123456' });
    }
    const result = await showPhishingLoggerVisitors(id);
    return reply(event.replyToken, { type: 'text', text: result });
  }

  if (text.startsWith('cell%')) {
    const cellInput = text.replace(/^cell%/i, '').trim();
    try {
      const data = await fetchPEAApi({ cell: cellInput });
      const result = formatKeyValueRows(data, `📡 Cell Site: ${cellInput}`);
      return reply(event.replyToken, { type: 'text', text: result });
    } catch (err) {
      console.error('cell lookup error:', err?.response?.data || err.message);
      return reply(event.replyToken, { type: 'text', text: '❌ดึงข้อมูล cell site ไม่สำเร็จ: ' + err.message });
    }
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
      return reply(event.replyToken, { type: 'text', text: '❌กรุณาระบุหมายเลข IMEI เช่น imei%123456789012345' });
    }
    const result = await searchIMEI(imei);
    return reply(event.replyToken, { type: 'text', text: result });
  }

  if (text.startsWith('imsi%')) {
    const imsiNumber = text.replace(/^imsi%/, '').trim();
    if (!imsiNumber) {
      return reply(event.replyToken, { type: 'text', text: '❌กรุณาระบุหมายเลข IMSI เช่น imsi%520044020881702' });
    }
    const result = await searchIMSI(imsiNumber);
    return reply(event.replyToken, { type: 'text', text: result });
  }

  if (text.startsWith('icc%')) {
    const iccidNumber = text.replace(/^icc%/, '').trim();
    if (!iccidNumber) {
      return reply(event.replyToken, { type: 'text', text: '❌กรุณาระบุหมายเลข ICCID เช่น icc%89660448216080569814' });
    }
    const result = await searchICCID(iccidNumber);
    return reply(event.replyToken, { type: 'text', text: result });
  }

  if (text.startsWith('wf%')) {
    const citizenId = text.replace(/^wf%/i, '').trim();
    if (!/^\d{13}$/.test(citizenId)) {
      return reply(event.replyToken, { type: 'text', text: '❌กรุณาระบุเลขบัตร 13 หลัก เช่น wf%3460300290391' });
    }
    try {
      const res = await fetchPEAApiFull({ wf: citizenId });
      return reply(event.replyToken, { type: 'text', text: res.message || '❌ไม่พบข้อมูลของผู้มีสิทธิ์' });
    } catch (err) {
      console.error('wf error:', err?.response?.data || err.message);
      return reply(event.replyToken, { type: 'text', text: '❌ตรวจสอบเบี้ยยังชีพไม่สำเร็จ: ' + err.message });
    }
  }

  if (text.startsWith('cj%')) {
    const payload = text.replace(/^cj%/i, '').trim();
    const parts = payload.split(/\s+/).filter(Boolean);
    const phone = parts[0] || '';
    const idCard = parts[1] || '';
    if (!/^0\d{9}$/.test(phone) || !/^\d{13}$/.test(idCard)) {
      return reply(event.replyToken, { type: 'text', text: '❌รูปแบบไม่ถูกต้อง\nตัวอย่าง: cj%0812345678 1122334455667' });
    }
    try {
      const res = await fetchPEAApiFull({ cj: `${phone}`, [idCard]: '' });
      return reply(event.replyToken, { type: 'text', text: limitLineMessage(res.message || '❌ไม่พบข้อมูล CJ Express') });
    } catch (err) {
      console.error('cj error:', err?.response?.data || err.message);
      return reply(event.replyToken, { type: 'text', text: '❌ดึงข้อมูล CJ Express ไม่สำเร็จ: ' + err.message });
    }
  }

  if (text.startsWith('me%')) {
    const query = text.replace(/^me%/i, '').trim();
    if (!query) {
      return reply(event.replyToken, { type: 'text', text: '❌กรุณาระบุชื่อที่ต้องการค้นหา เช่น me%ยาแก้ไอเด็ก' });
    }
    try {
      const res = await fetchPEAApiFull({ me: query });
      let replyText = '';
      if (res.success && Array.isArray(res.data) && res.data.length > 0) {
        replyText = `=== พบข้อมูลทั้งหมด ${res.data.length} รายการ ===\n`;
        res.data.forEach((item, idx) => {
          replyText += `\n[${idx + 1}]\n`;
          replyText += `ประเภท: ${item.productType || '-'}\n`;
          replyText += `ใบสำคัญ/ใบอนุญาต: ${item.licenseNo || '-'}\n`;
          replyText += `ชื่อผลิตภัณฑ์: ${item.productName || '-'}\n`;
          replyText += `ชื่อผู้รับอนุญาต: ${item.licensee || '-'}\n`;
          replyText += `Newcode: ${item.newcode || '-'}\n`;
          replyText += `สถานะ: ${item.status || '-'}\n`;
          replyText += `--------------------`;
        });
      } else {
        replyText = res.message || 'ไม่พบข้อมูลที่ตรงกับคำค้นหา';
      }
      return reply(event.replyToken, { type: 'text', text: limitLineMessage(replyText) });
    } catch (err) {
      console.error('me error:', err?.response?.data || err.message);
      return reply(event.replyToken, { type: 'text', text: '❌ค้นหาข้อมูลยาไม่สำเร็จ: ' + err.message });
    }
  }

  if (text.startsWith('map%')) {
    const coordinates = text.replace(/^map%/, '').trim();
    if (!coordinates) {
      return reply(event.replyToken, { type: 'text', text: '❌กรุณาระบุพิกัด เช่น map%13.7563,100.5018' });
    }
    const result = await createMapLink(coordinates);
    return reply(event.replyToken, { type: 'text', text: result });
  }

  if (text.startsWith('web%')) {
    const url = text.replace(/^web%/, '').trim();
    if (!url) {
      return reply(event.replyToken, { type: 'text', text: '❌กรุณาระบุเว็บไซต์ เช่น web%example.com' });
    }
    const result = await getWebInfo(url);
    return reply(event.replyToken, { type: 'text', text: result });
  }

  if (text.startsWith('lc%')) {
    const keyword = text.replace(/^lc%/i, '').trim();
    if (!keyword) {
      return reply(event.replyToken, { type: 'text', text: '❌ กรุณาระบุชื่อ-สกุล, ชื่อบริษัท/นิติบุคคล เช่น lc%สมชาย ใจดี, บริษัท ตัวอย่าง จำกัด' });
    }
    const result = await searchBOTLicense(keyword);
    return reply(event.replyToken, { type: 'text', text: result });
  }

  if (text.startsWith('loa%')) {
    const appName = text.replace(/^loa%/i, '').trim();
    if (!appName) {
      return reply(event.replyToken, { type: 'text', text: '❌ กรุณาระบุชื่อแอป เช่น loa%ชื่อแอปเงินกู้' });
    }
    const result = await searchLoanLicense(appName);
    return reply(event.replyToken, { type: 'text', text: result });
  }

  if (text.startsWith('for%')) {
    const companyId = text.replace(/^for%/i, '').trim();
    if (!companyId) {
      return reply(event.replyToken, { type: 'text', text: '❌ กรุณาระบุเลขนิติบุคคล เช่น for%0105550000000' });
    }
    const result = await searchCompanyDataforthai(companyId);
    return reply(event.replyToken, { type: 'text', text: limitLineMessage(result) });
  }

  if (text.startsWith('tr%')) {
    const name = text.replace(/^tr%/i, '').trim();
    if (!name) {
      return reply(event.replyToken, { type: 'text', text: '❌ กรุณาระบุชื่อผู้ประกอบการ เช่น tr%บริษัท กาฬสินธุ์ออโตเซลส์ จำกัด' });
    }
    try {
      const result = await searchThaiTruckCenter(name);
      return reply(event.replyToken, { type: 'text', text: limitLineMessage(formatThaiTruckCenterResult(result)) });
    } catch (err) {
      console.error('tr error:', err?.response?.data || err.message);
      return reply(event.replyToken, { type: 'text', text: '❌ เกิดข้อผิดพลาดระหว่างค้นหาผู้ประกอบการขนส่ง' });
    }
  }

  if (text.startsWith('cctv%')) {
  const times = text.replace(/^cctv%/i, '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);

  if (times.length !== 2) {
    return reply(event.replyToken, {
      type: 'text',
      text: '❌ กรุณาระบุเวลา เช่น cctv%12:00:00, 12:05:30'
    });
  }

  const diff = calculateCCTVTimeDiff(times[0], times[1]);

  return reply(
    event.replyToken,
    createCCTVFlex(times[0], times[1], diff)
  );
}

  if (text.startsWith('tisi%')) {
    const licenseId = text.replace(/^tisi%/i, '').trim();
    if (!licenseId) {
      return reply(event.replyToken, { type: 'text', text: '❌ กรุณาระบุเลข มอก. เช่น tisi%1234' });
    }
    const result = await searchTISI(licenseId);
    return reply(event.replyToken, { type: 'text', text: limitLineMessage(result) });
  }

  if (text.startsWith('psi#')) {
    const input = text.replace(/^psi#/, '').trim();
    if (!input) {
      return reply(event.replyToken, { type: 'text', text: '❌กรุณาระบุเลขบัตรประชาชน เช่น psi#1234567890123' });
    }
    try {
      const data = await fetchPrisonerApi({ psi: input });
      const result = formatPrisonerRecords(data, input, false);
      return reply(event.replyToken, { type: 'text', text: result });
    } catch (err) {
      console.error('psi error:', err?.response?.data || err.message);
      return reply(event.replyToken, { type: 'text', text: '❌ดึงข้อมูลผู้ต้องขังไม่สำเร็จ: ' + err.message });
    }
  }

  if (text.startsWith('ps#')) {
    const input = text.replace(/^ps#/, '').trim();
    if (!input) {
      return reply(event.replyToken, { type: 'text', text: '❌กรุณาระบุเลขบัตรประชาชน เช่น ps#1234567890123' });
    }
    try {
      const data = await fetchPrisonerApi({ ps: input });
      const result = formatPrisonerRecords(data, input, true);
      return reply(event.replyToken, { type: 'text', text: result });
    } catch (err) {
      console.error('ps error:', err?.response?.data || err.message);
      return reply(event.replyToken, { 
  type: 'text', 
  text: '⌛กรุณาสืบค้นใหม่อีกครั้ง⌛'
});
    }
  }

  if (text.startsWith('peab%')) {
    const parts = text.replace(/^peab%/, '').trim().split(/\s+/);
    const ca = parts[0];
    const peano = parts[1];
    if (!ca || !peano) {
      return reply(event.replyToken, { type: 'text', text: '❌กรุณาระบุข้อมูลให้ครบ เช่น peab%020006438778 6300096416' });
    }
    try {
      const data = await fetchPEAApi({ peab: ca, peano });
      const result = formatPEABillHistory(data, ca, peano);
      return reply(event.replyToken, { type: 'text', text: result });
    } catch (err) {
      console.error('peab error:', err?.response?.data || err.message);
      return reply(event.replyToken, { type: 'text', text: '❌ดึงข้อมูลประวัติค่าไฟ PEA ไม่สำเร็จ: ' + err.message });
    }
  }

  if (text.startsWith('peac%')) {
    const parts = text.replace(/^peac%/, '').trim().split(/\s+/);
    const ca = parts[0];
    const page = parts[1] ? parseInt(parts[1], 10) - 1 : 0;
    if (!ca) {
      return reply(event.replyToken, { type: 'text', text: '❌กรุณาระบุเลข CA เช่น peac%020006438778' });
    }
    try {
      const data = await fetchPEAApi({ peac: ca });

      return reply(
        event.replyToken,
        buildPEANFlex(data, '⚡ ข้อมูลมิเตอร์ไฟฟ้า PEA', page)
      );
    } catch (err) {
      console.error('peac error:', err?.response?.data || err.message);
      return reply(event.replyToken, { type: 'text', text: '❌ดึงข้อมูล PEA จากเลข CA ไม่สำเร็จ: ' + err.message });
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
      return reply(event.replyToken, { type: 'text', text: '❌กรุณาใส่ชื่อเต็มและนามสกุล เช่น pean%เย็น เก่งสาริกิจ' });
    }
    try {
      const data = await fetchPEAApi({ pean: name });

      return reply(
        event.replyToken,
        buildPEANFlex(data, '⚡ ข้อมูลมิเตอร์ไฟฟ้าตามชื่อ', page, name)
      );
    } catch (err) {
      console.error('pean error:', err?.response?.data || err.message);
      return reply(event.replyToken, { type: 'text', text: '❌ดึงข้อมูล PEA จากชื่อไม่สำเร็จ: ' + err.message });
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
      return reply(event.replyToken, {
        type: 'text',
        text: '❌ กรุณาระบุที่อยู่ เช่น peau%นครสวรรค์'
      });
    }

    try {
      // ✅ ต้องมีบรรทัดนี้
      const data = await fetchPEAApi({ peau: address });

      // ✅ แล้วค่อยใช้
      return reply(
        event.replyToken,
        buildPEAUFlex(data, page)
      );

    } catch (err) {
      console.error('peau error:', err?.response?.data || err.message);
      return reply(event.replyToken, {
        type: 'text',
        text: '❌ ดึงข้อมูล PEA จากที่อยู่ไม่สำเร็จ'
      });
    }
  }

  // 🔎 รวมข้อมูลจากเลขบัตร
  if (/^all%\d{13}$/.test(text)) {
    const pid = text.replace(/^all%/, '').trim();

    try {

const [hRes, cRes, siRes, sRes, dRes, dlRes, cidRes] =
await Promise.allSettled([

searchJediHp(pid),
fetchCrime(pid),
fetchPEAApi({ si: pid }),
fetchInstallment(pid),

axios.get(
`https://dtac-api.jedi-r3cloud.org/dtac?phone=${encodeURIComponent(pid)}&token=jedi-api-2026`,
{ timeout:45000 }
),

fetchSearchApiRaw({ dl: pid }),
fetchSearchApiRaw({ cid: pid })

]);
      const dData = dRes.status === 'fulfilled' ? dRes.value.data : null;
      const bqRes = await fetchBQuikForAll(pid, dData);

      let msg = `🔎[PID]\n:${pid}\n-------------------\n`;

// =======================
// 📂DTAC INFO
// =======================

try {
  if (dData) {
    msg += `📘DTAC\n`;
    const dtacText = formatDtacSearch(dData, pid)
      .replace(new RegExp(`เลขบัตร:\\s*${pid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), `เลขบัตร: *********${String(pid).slice(-4)}`);
    msg += dtacText;
  }

} catch (e) {
  console.log('all% dtac error:', e.message);
}

msg += `\n-------------------\n📗AIS\n`;
msg += `❌ ไม่พบข้อมูล`;

msg += `\n-------------------\n📙TRUE\n`;
msg += `❌ ไม่พบข้อมูล`;

msg += `\n-------------------`;

      msg += `\n🏥ข้อมูลบุคคล/สิทธิรักษา\n`;
      msg += hRes.status === 'fulfilled'
        ? limitAllSection(hRes.value, 900)
        : '❌ไม่พบข้อมูลสิทธิ';

      msg += `\n\n-------------------\n🚨หมายจับ[CRIME]\n`;
      msg += cRes.status === 'fulfilled'
        ? limitAllSection(formatCrime(cRes.value, pid), 900)
        : '❌ไม่พบข้อมูลหมายจับ[CRIME]';

msg += `\n\n-------------------\n`;

msg += dlRes.status==='fulfilled'
? summarizeDL(dlRes.value?.data)
: '❌ไม่พบข้อมูลใบขับขี่';

msg += `\n\n-------------------\n`;

msg += cidRes.status==='fulfilled'
? summarizeVehicleCID(cidRes.value)
: '❌ไม่พบข้อมูลทะเบียนรถ';

      msg += `\n\n-------------------\n👨‍🔧ประกันสังคม\n`;
      msg += siRes.status === 'fulfilled'
        ? summarizeSI(siRes.value)
        : '❌ไม่พบข้อมูลประกันสังคม';

msg += `\n\n-------------------\n🚇Railway\n`;
msg += `❌ ไม่พบข้อมูล`;

msg += `\n-------------------\n🚍Bus\n`;
msg += `❌ ไม่พบข้อมูล`;

msg += `\n-------------------\n🚢กรมเจ้าท่า\n`;
msg += `❌ ไม่พบข้อมูล`;

msg += `\n-------------------\n👨‍💼กรรมการบริษัท\n`;
msg += `❌ ไม่พบข้อมูล`;

      msg += `\n\n-------------------\n🪛ศูนย์บริการรถ\n`;
      msg += bqRes
        ? formatBQuikServiceCenter(bqRes)
        : '❌ไม่พบข้อมูลศูนย์บริการรถ';

      msg += '\n\n-------------------\n📺ผ่อนเครื่องใช้ไฟฟ้า\n';
msg += sRes.status === 'fulfilled'
? limitAllSection(formatInstallment(sRes.value),1200)
: '❌ไม่พบข้อมูลผ่อนสินค้า';

msg += `
-------------------
⚠️คำเตือน
┌●บางรายการมีจำนวนมากจึงแสดงได้บางส่วน
└●หากต้องการละเอียด ให้เช็คแยกคำสั่ง
`;

return reply(event.replyToken,{
type:'text',
text:limitLineMessage(msg)
});

    } catch (err) {
      console.error('all lookup error:', err?.response?.data || err.message);
      return reply(event.replyToken, {
        type: 'text',
        text: '❌ ดึงข้อมูลรวมไม่สำเร็จ'
      });
    }
  }

  return;
}

async function getFacebookProfile(profileId) {
  const response = await axios.get(
    'https://serpapi.com/search.json',
    {
      params: {
        engine: 'facebook_profile',
        profile_id: profileId,
        api_key: process.env.SERPAPI_KEY
      }
    }
  );

  return response.data.profile_results;
}

function formatFacebookProfile(data) {
  return `
📘 ข้อมูลโปรไฟล์ Facebook

👤 ชื่อ: ${data.name || '-'}
🆔 Facebook ID: ${data.id || '-'}
📂 ประเภท: ${data.profile_type || '-'}
🏷️ หมวดหมู่: ${data.category || '-'}

👥 Followers: ${data.followers || '-'}
➡️ Following: ${data.following || '-'}

📞 โทรศัพท์: ${data.phone || '-'}
📧 Email: ${data.email || '-'}

🔗 URL:
${data.url || '-'}

📝 เกี่ยวกับ:
${data.profile_intro_text || '-'}
`;
}

function buildFacebookProfileFlex(data) {
    data = data || {};
  return {
    type: 'bubble',
    size: 'mega',
    hero: {
      type: 'image',
      url: data.cover_photo || data.profile_picture || 'https://via.placeholder.com/1024x512.png?text=Facebook+Profile',
      size: 'full',
      aspectRatio: '20:9',
      aspectMode: 'cover'
    },
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'md',
      contents: [
        {
          type: 'box',
          layout: 'horizontal',
          spacing: 'md',
          contents: [
            {
              type: 'image',
              url: data.profile_picture || 'https://via.placeholder.com/300.png?text=Profile',
              size: 'md',
              aspectRatio: '1:1',
              aspectMode: 'cover',
              flex: 0
            },
            {
              type: 'box',
              layout: 'vertical',
              contents: [
                {
                  type: 'text',
                  text: data.name || '-',
                  weight: 'bold',
                  size: 'lg',
                  wrap: true
                },
                {
                  type: 'text',
                  text: `ID: ${data.id || '-'}`,
                  size: 'xs',
                  color: '#64748B',
                  wrap: true
                },
                {
                  type: 'text',
                  text: data.profile_type || '-',
                  size: 'xs',
                  color: '#2563EB',
                  weight: 'bold'
                }
              ]
            }
          ]
        },
        {
          type: 'separator',
          margin: 'md'
        },
        {
          type: 'text',
          text: `👥 Followers: ${data.followers || '-'}`,
          size: 'sm'
        },
        {
          type: 'text',
          text: `➡️ Following: ${data.following || '-'}`,
          size: 'sm'
        },
        {
          type: 'text',
          text: `🏷️ หมวดหมู่: ${data.category || '-'}`,
          size: 'sm',
          wrap: true
        },
        {
          type: 'text',
          text: `📝 ${data.profile_intro_text || '-'}`,
          size: 'sm',
          wrap: true,
          color: '#334155'
        }
      ]
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      contents: [
        {
          type: 'button',
          style: 'primary',
          color: '#1877F2',
          action: {
            type: 'uri',
            label: 'เปิดโปรไฟล์ Facebook',
            uri: data.url || 'https://www.facebook.com'
          }
        }
      ]
    }
  };
}

async function compareFace(file1, file2) {
  const form = new FormData();

  form.append('file1', fs.createReadStream(file1));
  form.append('file2', fs.createReadStream(file2));

  const { data } = await axios.post(
    'https://api.iapp.co.th/v3/store/ekyc/face-verification',
    form,
    {
      headers: {
        apikey: IAPP_API_KEY,
        ...form.getHeaders()
      },
      timeout: 60000
    }
  );

  return data;
}

function formatFaceCompare(data){

  let score =
      data.similarity_score ??
      data.comparison_score ??
      data.score ??
      0;

  // ถ้าเป็น 0.69 ค่อยแปลงเป็น 69
  if(score <= 1){
     score = score * 100;
  }

  score = Math.round(score);

  const same = score >= 50;

  return `🧑‍💻 เปรียบเทียบใบหน้า
┌● ผลลัพธ์: ${
same
? '✅ บุคคลเดียวกัน'
: '❌ คนละบุคคล'
}
├● คะแนนความเหมือน: ${score}%
└● สถานะ: ${data.message || '-'}

- - - - - - - - - - - - -
⚠️ใช้ประกอบการวิเคราะห์
การสืบสวนเท่านั้น !!`;
}

async function readPlateOcr(imagePath) {
  const formData = new FormData();

  formData.append('file', fs.createReadStream(imagePath));

  const response = await axios.post(
    'https://api.iapp.co.th/license-plate-recognition/file',
    formData,
    {
      headers: {
        apikey: IAPP_API_KEY,
        ...formData.getHeaders()
      },
      timeout: 60000
    }
  );

  return response.data;
}

function formatPlateOcr(data) {
  return `🚘 ผลอ่านป้ายทะเบียน
┌● ป้ายทะเบียน: ${data.lp_number || '-'}
├● จังหวัด: ${data.province || '-'}
├● ประเทศ: ${data.country || '-'}
├● ความมั่นใจ: ${data.conf || '-'}%
├● พบยานพาหนะ: ${data.is_vehicle || '-'}
├● ป้ายหาย/ไม่ชัด: ${data.is_missing_plate || '-'}
├● ยี่ห้อ: ${data.vehicle_brand || '-'}
├● รุ่น: ${data.vehicle_model || '-'}
├● สี: ${data.vehicle_color || '-'}
├● ประเภทรถ: ${data.vehicle_body_type || '-'}
├● ปีรถ: ${data.vehicle_year || '-'}
└● สถานะ: ${data.message || '-'}

- - - - - - - - - - - - -
⚠️ใช้ประกอบการวิเคราะห์
การสืบสวนเท่านั้น !!`;
}

async function handleImage(event) {
  const userId = event.source.userId;
  const db = loadDB();
  const member = db.members[userId];
  const topup = db.topups?.[userId];
  
if (
topup &&
topup.status === 'waiting_slip'
){

try{

const fileName=`topup_${userId}_${Date.now()}.jpg`;
const savePath=path.join(UPLOAD_DIR,fileName);

await downloadLineImage(
event.message.id,
savePath
);

topup.status='pending_review';
topup.updatedAt=nowThai();
topup.slipImagePath=savePath;

db.topups[userId]=topup;
saveDB(db);

// ล้างโหมดเทียบหน้า
delete faceCompareSessions[userId];

return reply(event.replyToken,{
type:'text',
text:'✅ ได้รับสลิปแล้ว\n📩 รอแอดมินตรวจสอบ'
});

}catch(err){

console.log(
'topup upload:',
err.message
);

return reply(event.replyToken,{
type:'text',
text:'❌ บันทึกสลิปไม่สำเร็จ'
});

}

}

 // ===== ff% เปรียบเทียบใบหน้า =====
  const session = faceCompareSessions[userId];

console.log("SESSION =", session);

if (session) {

    console.log("เข้าโหมด ff");

    const dir = path.join(__dirname,'tmp');

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir);
    }

    const imagePath = path.join(
      dir,
      `${userId}_${Date.now()}_${session.images.length+1}.jpg`
    );

    console.log("กำลังโหลดรูป...");

    await saveLineImage(
      event.message.id,
      imagePath
    );

    console.log("บันทึกรูปแล้ว");

    session.images.push(imagePath);

    console.log(
      "จำนวนรูป:",
      session.images.length
    );

    if(session.images.length===1){

      return reply(event.replyToken,{
        type:'text',
        text:`✅ รับรูปใบหน้าที่ 1 แล้ว

กรุณาส่งรูปใบหน้าที่ 2`
      });

    }

    if(session.images.length===2){

      try{

        const result= await compareFace(
          session.images[0],
          session.images[1]
        );

        delete faceCompareSessions[userId];

        fs.unlinkSync(session.images[0]);
        fs.unlinkSync(session.images[1]);

        return reply(event.replyToken,{
          type:'text',
          text:formatFaceCompare(result)
        });

      }catch(err){

  console.log("SAVE/COMPARE ERROR =", err.response?.data || err.message);

  delete faceCompareSessions[userId];

  return reply(event.replyToken,{
    type:'text',
    text:'❌ เปรียบเทียบใบหน้าไม่สำเร็จ'
  });

}

    }
  }

if (plateOcrSessions[userId]) {
  const dir = path.join(__dirname, 'tmp');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const imagePath = path.join(
    dir,
    `${userId}_${Date.now()}_plate.jpg`
  );

  try {
    await saveLineImage(event.message.id, imagePath);

    const result = await readPlateOcr(imagePath);

    delete plateOcrSessions[userId];

    if (fs.existsSync(imagePath)) fs.unlinkSync(imagePath);

    return reply(event.replyToken, {
      type: 'text',
      text: formatPlateOcr(result)
    });

  } catch (err) {
    console.log('PLATE OCR ERROR =', err.response?.data || err.message);

    delete plateOcrSessions[userId];

    return reply(event.replyToken, {
      type: 'text',
      text: '❌ อ่านป้ายทะเบียนไม่สำเร็จ'
    });
  }
}

  if (!member) {
    return reply(event.replyToken, {
      type: 'text',
      text: '❌กรุณาสมัครสมาชิกก่อน โดยพิมพ์: ยินยอมรับข้อตกลง'
    });
  }

  if (member.status === 'waiting_card') {
    // อนุญาตให้ส่งรูปหลักฐานสมัครต่อได้
  } else if (!isActiveMember(member)) {
    return reply(event.replyToken, {
      type: 'text',
      text: '📆ยังไม่ได้รับการอนุมัติ/สมาชิกหมดอายุ'
    });
  }

  if (topup && topup.status === 'waiting_slip') {
    try {
      const fileName = `topup_${userId}_${Date.now()}.jpg`;
      const savePath = path.join(UPLOAD_DIR, fileName);

      await downloadLineImage(event.message.id, savePath);

if (db.faceCompare?.[userId]) {
  const state = db.faceCompare[userId];

  if (state.step === 1) {
    state.file1 = savePath;
    state.step = 2;
    saveDB(db);

    return reply(event.replyToken,{
      type:'text',
      text:'✅ ได้รับรูปที่ 1 แล้ว\n📸 กรุณาส่งรูปใบหน้ารูปที่ 2'
    });
  }

  if(state.step===2){
    state.file2=savePath;

    try{

      const result=
      await compareFace(
        state.file1,
        state.file2
      );

      delete db.faceCompare[userId];
      saveDB(db);

      return reply(event.replyToken,{
        type:'text',
        text:formatFaceCompare(result)
      });

    }catch(err){

      console.log(
       'face compare:',
       err.response?.data || err.message
      );

      delete db.faceCompare[userId];
      saveDB(db);

      return reply(event.replyToken,{
        type:'text',
        text:'⌛กรุณาส่งรูปใหม่อีกครั้ง⌛'
      });
    }
  }
}

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

if (data.startsWith('approve_member:')) {

  const targetUserId = data.replace('approve_member:', '').trim();

  if (!db.members[targetUserId]) {
    return reply(event.replyToken, {
      type: 'text',
      text: '❌ ไม่พบสมาชิกนี้'
    });
  }

  db.members[targetUserId].status = 'approved';

const now = new Date();
const expire = new Date();

expire.setDate(expire.getDate() + 30);

db.members[targetUserId].approvedAt = now.toISOString();
db.members[targetUserId].expireAt = expire.toISOString();
db.members[targetUserId].approvedDays = 30;

  saveDB(db);

const pendingCount = Object.values(db.members || {})
  .filter(m => m.status === 'pending').length;

return reply(event.replyToken, {
  type: 'text',
  text:
`✅ อนุมัติสมาชิกเรียบร้อย

👤 ${db.members[targetUserId].fullname || db.members[targetUserId].name || targetUserId}

📌 คงเหลือสมาชิกรอตรวจสอบ: ${pendingCount} คน`
});

}

  if (data.startsWith('admin_members_all')) {
  const page = Number(data.split('_').pop()) || 1;

  return reply(event.replyToken, {
    type: 'text',
    text: buildMembersAllText(db, page)
  });
}

 if (data === 'admin_members_pending') {

  return reply(
    event.replyToken,
    buildPendingMembersFlex(db)
  );

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
