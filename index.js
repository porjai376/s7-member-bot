require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const https = require('https');

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
  process.env.INSTALLMENT_API_URL ||
  'http://scsinfo.pieare.com/securestock/api/installmentprint/inspection/inspect';

const httpsAgent = new https.Agent({
  rejectUnauthorized: false
});

const config = {
  channelSecret: CHANNEL_SECRET
};

const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: CHANNEL_ACCESS_TOKEN
});

// ===== PERSISTENT STORAGE =====
const STORAGE_ROOT = process.env.STORAGE_ROOT || '/var/data';
const DATA_FILE = path.join(STORAGE_ROOT, 'members.json');
const UPLOAD_DIR = path.join(STORAGE_ROOT, 'uploads');

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
  console.log(`STORAGE_ROOT: ${STORAGE_ROOT}`);
  console.log(`DATA_FILE: ${DATA_FILE}`);
  console.log(`UPLOAD_DIR: ${UPLOAD_DIR}`);
});

function ensureStorage() {
  if (!fs.existsSync(STORAGE_ROOT)) {
    fs.mkdirSync(STORAGE_ROOT, { recursive: true });
  }

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

  const accountStatus = safe(p.is_active) === 'YES'
    ? '🟢 ใช้งานอยู่'
    : '🔴 ไม่ใช้งาน';

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

  const homes = addresses.filter(a => (a.type || '').toUpperCase() === 'HOME');
  const works = addresses.filter(a => (a.type || '').toUpperCase() === 'WORK');

  const shortAddr = (a) => {
    if (!a || !a.full_address) return '-';
    return a.full_address
      .replace(/ตำบล/g, 'ต.')
      .replace(/อำเภอ/g, 'อ.')
      .replace(/จังหวัด/g, 'จ.');
  };

  let addrBlock = '';
  const totalAddr = homes.length + works.length;

  if (totalAddr > 0) {
    addrBlock += `\n\n🏚️ [ที่อยู่ ${totalAddr} รายการ]\n\n`;

    homes.forEach((h, i) => {
      addrBlock += `┌● HOME [${i + 1}]:\n${shortAddr(h)}\n\n`;
    });

    works.forEach((w, i) => {
      addrBlock += `└● WORK [${i + 1}]:\n${shortAddr(w)}\n\n`;
    });
  }

  return (
`🔎[${safe(p.nationid)}] MEGABOT🤖
┌● Name: ${safe(p.fullname)}
├● ID: ${safe(p.nationid)}
├● วันเกิด: ${formatThaiBirth(p.birth)}
├● สถานะสมรส: ${safe(p.marital_status)}
├● สถานะบัญชี: ${accountStatus}
├● เบอร์โทรศัพท์: ${safe(p.mobile)}
├● อีเมล: ${safe(p.email)}
├● Line ID: ${safe(p.lineid)}
├● วันที่สร้างข้อมูล: ${safe(p.created_at)}
└● ติดต่อล่าสุดเมื่อ: ${safe(p.updated_at)}`
  ) + addrBlock;
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
                '┗ ╾ who#เบอร์โทร'
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
                '┗ ╾ fx#เบอร์โทร/ชื่อสกุล'
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
              menuSection('⚖️ หมายจับ', [
                '┗ ╾ c#เลขบัตร / doc#เลขบัตร'
              ]),
              menuSection('⚡ ไฟฟ้า / อื่นๆ', [
                '┣ ╾ mea%ชื่อสกุล',
                '┣ ╾ kru%เลขมิเตอร์',
                '┣ ╾ peab%เลข CA เลขมิเตอร์',
                '┣ ╾ peac%เลข CA',
                '┣ ╾ pean%ชื่อสกุล',
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
  if (isAdmin(userId)) return true;

  const publicCommands = [
    'menu%',
    'ยินยอมรับข้อตกลง',
    'สถานะการสมัคร'
  ];

  if (publicCommands.includes(text)) return true;
  if (text.startsWith('regis%')) return true;

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
        text: '❌ ยังไม่มีสิทธิ์ใช้งาน\nกรุณาสมัครสมาชิกก่อน โดยพิมพ์: ยินยอมรับข้อตกลง'
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
  }

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

    return reply(event.replyToken, {
      type: 'text',
      text:
        `สถานะการสมัคร\n` +
        `ชื่อ: ${member.fullname || '-'}\n` +
        `สถานะ: ${statusText}\n` +
        `อนุมัติ: ${member.approvedAt || '-'}\n` +
        `อายุสมาชิก: ${member.approvedDays || 0} วัน\n` +
        `หมดอายุ: ${member.expireAt ? formatThaiDate(member.expireAt) : '-'}\n` +
        `เวลาล่าสุด: ${member.updatedAt || member.registeredAt || '-'}`
    });
  }

  if (/^%66\d{8,15}$/.test(text)) {
    return reply(event.replyToken, {
      type: 'text',
      text: '⚠️ คำสั่ง %66 ยังไม่เปิดใช้งานในระบบนี้'
    });
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

  return reply(event.replyToken, {
    type: 'text',
    text: 'พิมพ์ menu% เพื่อดูเมนู หรือพิมพ์ ยินยอมรับข้อตกลง เพื่อสมัครสมาชิก'
  });
}

async function handleImage(event) {
  const userId = event.source.userId;
  const db = loadDB();
  const member = db.members[userId];
  const topup = db.topups?.[userId];

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
