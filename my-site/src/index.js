// Cloudflare Worker API proxy
// مسیر: POST /api/ai-proxy
// Secrets موردنیاز در Cloudflare:
// GEMINI_API_KEY
// GROQ_API_KEY
// DEEPSEEK_API_KEY
// BRAVE_SEARCH_API_KEY (اختیاری؛ برای جستجوی وب دقیق‌تر)

const JSON_HEADERS = {
  'content-type': 'application/json; charset=UTF-8',
  'cache-control': 'no-store'
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders()
      });
    }

    if (url.pathname === '/api/ai-proxy') {
      if (request.method !== 'POST') {
        return json({
          ok: true,
          service: 'ai-proxy',
          message: 'Use POST /api/ai-proxy'
        });
      }

      return handleAiProxy(request, env);
    }

    // نمایش سایت از طریق Static Assets
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response('Not found', { status: 404 });
  }
};

async function handleAiProxy(request, env) {
  let body;

  try {
    body = await request.json();
  } catch {
    return json({
      error: 'بدنه درخواست JSON معتبر نیست.'
    }, 400);
  }

  const provider = String(body.provider || '').trim();
  const model = String(body.model || '').trim();
  const message = String(body.message || '').trim();

  if (!provider || !model || !message) {
    return json({
      error: 'provider، model و message الزامی هستند.'
    }, 400);
  }

  if (message.length > 12000) {
    return json({
      error: 'متن پیام بیش از حد طولانی است.'
    }, 413);
  }

  try {
    if (provider === 'gemini') {
      return await callGemini(
        env.GEMINI_API_KEY,
        model,
        message
      );
    }

    if (provider === 'groq') {
      return await callOpenAICompatible(
        env.GROQ_API_KEY,
        'https://api.groq.com/openai/v1/chat/completions',
        model,
        message
      );
    }

    if (provider === 'deepseek') {
      return await callOpenAICompatible(
        env.DEEPSEEK_API_KEY,
        'https://api.deepseek.com/chat/completions',
        model,
        message
      );
    }

    if (provider === 'websearch') {
      return await handleWebSearch(env, message);
    }

    return json({
      error: 'این سرویس در پروکسی فعال نیست.'
    }, 400);

  } catch (err) {
    console.error('AI proxy error:', err);

    return json({
      error: safeError(err)
    }, 502);
  }
}


// ==============================
// GEMINI
// ==============================

async function callGemini(key, model, message) {
  if (!key) {
    return json({
      error: 'GEMINI_API_KEY روی Cloudflare تنظیم نشده است.'
    }, 500);
  }

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: message
            }
          ]
        }
      ],
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 2048
      }
    })
  });

  const data = await readJson(res);

  if (!res.ok || data.error) {
    return json({
      error:
        data.error?.message ||
        `Gemini HTTP ${res.status}`
    }, 502);
  }

  const text =
    data.candidates?.[0]?.content?.parts
      ?.map(p => p.text || '')
      .join('') || '';

  if (!text) {
    return json({
      error: 'Gemini پاسخ متنی برنگرداند.'
    }, 502);
  }

  return json({ text });
}


// ==============================
// GROQ / DEEPSEEK
// ==============================

async function callOpenAICompatible(
  key,
  endpoint,
  model,
  message
) {
  if (!key) {
    return json({
      error: 'کلید API این سرویس روی Cloudflare تنظیم نشده است.'
    }, 500);
  }

  const payload = {
    model,
    messages: [
      {
        role: 'user',
        content: message
      }
    ],
    temperature: 0.7
  };

  // DeepSeek V4 از thinking mode پشتیبانی می‌کند.
  // برای چت معمولی حالت non-thinking را استفاده می‌کنیم.
  if (model.startsWith('deepseek-v4-')) {
    payload.thinking = {
      type: 'disabled'
    };
  }

  const res = await fetch(endpoint, {
    method: 'POST',

    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${key}`
    },

    body: JSON.stringify(payload)
  });

  const data = await readJson(res);

  if (!res.ok || data.error) {
    return json({
      error:
        data.error?.message ||
        `Provider HTTP ${res.status}`
    }, 502);
  }

  const text =
    data.choices?.[0]?.message?.content || '';

  if (!text) {
    return json({
      error: 'سرویس AI پاسخ متنی برنگرداند.'
    }, 502);
  }

  return json({ text });
}


// ==============================
// WEB SEARCH
// ==============================

async function handleWebSearch(env, query) {

  const cleanQuery =
    query
      .replace(/^@?جستجوی وب\s*/i, '')
      .trim() || query;

  let results;

  if (env.BRAVE_SEARCH_API_KEY) {
    results = await braveSearch(
      env.BRAVE_SEARCH_API_KEY,
      cleanQuery
    );
  } else {
    results = await duckDuckGoSearch(cleanQuery);
  }

  if (!results.length) {
    return json({
      text:
        'برای این عبارت نتیجه قابل استفاده‌ای پیدا نشد. برای نتایج دقیق‌تر، BRAVE_SEARCH_API_KEY را در Secrets کلادفلر تنظیم کنید.'
    });
  }

  const context =
    results
      .slice(0, 8)
      .map((r, i) =>
        `${i + 1}. ${r.title}\n${r.url}\n${r.description || ''}`
      )
      .join('\n\n');

  const prompt = `
تو یک دستیار جستجوی وب هستی.

فقط بر اساس نتایج زیر پاسخ بده.

اگر اطلاعات کافی نیست، صریح بگو.

پاسخ را فارسی، خلاصه و دقیق بنویس.

ادعاهای زمان‌حساس را قطعی جلوه نده.

سؤال کاربر:
${cleanQuery}

نتایج وب:
${context}
`;

  let answer = null;

  if (env.GEMINI_API_KEY) {

    answer = await getGeminiText(
      env.GEMINI_API_KEY,
      'gemini-3.5-flash',
      prompt
    );

  } else if (env.GROQ_API_KEY) {

    answer = await getOpenAICompatibleText(
      env.GROQ_API_KEY,
      'https://api.groq.com/openai/v1/chat/completions',
      'llama-3.1-8b-instant',
      prompt
    );

  } else if (env.DEEPSEEK_API_KEY) {

    answer = await getOpenAICompatibleText(
      env.DEEPSEEK_API_KEY,
      'https://api.deepseek.com/chat/completions',
      'deepseek-chat',
      prompt
    );
  }

  const text =
    answer ||
    results
      .map(
        (r, i) =>
          `${i + 1}. ${r.title}\n${r.description || ''}`
      )
      .join('\n\n');

  return json({
    text,
    sources: results.slice(0, 8)
  });
}


// ==============================
// BRAVE SEARCH
// ==============================

async function braveSearch(key, query) {

  const url =
    `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=8&search_lang=fa&ui_lang=fa-IR`;

  const res = await fetch(url, {
    headers: {
      'accept': 'application/json',
      'x-subscription-token': key
    }
  });

  const data = await readJson(res);

  if (!res.ok) {
    throw new Error(
      data.message ||
      `Brave Search HTTP ${res.status}`
    );
  }

  return (
    data.web?.results || []
  ).map(r => ({
    title: r.title || r.url,
    url: r.url,
    description: r.description || ''
  }));
}


// ==============================
// DUCKDUCKGO FALLBACK
// ==============================

async function duckDuckGoSearch(query) {

  const url =
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

  const res = await fetch(url, {
    headers: {
      'user-agent':
        'Mozilla/5.0 (compatible; MohamadAI/1.0)',
      'accept-language':
        'fa,en;q=0.8'
    }
  });

  const html = await res.text();

  if (!res.ok) {
    throw new Error(
      `DuckDuckGo HTTP ${res.status}`
    );
  }

  const results = [];

  const blockRe =
    /<div[^>]+class="result[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi;

  let m;

  while (
    (m = blockRe.exec(html)) &&
    results.length < 8
  ) {

    const block = m[1];

    const a =
      /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i
        .exec(block);

    if (!a) continue;

    let href = decodeHtml(a[1]);

    const title = stripHtml(a[2]);

    const sn =
      /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i
        .exec(block)
      ||
      /<div[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/div>/i
        .exec(block);

    const description =
      sn ? stripHtml(sn[1]) : '';

    if (
      href.startsWith(
        '//duckduckgo.com/l/?'
      )
    ) {
      try {
        href =
          new URL(
            'https:' + href
          ).searchParams.get('uddg') ||
          href;
      } catch {}
    }

    if (href.startsWith('http')) {
      results.push({
        title,
        url: href,
        description
      });
    }
  }

  return results;
}


// ==============================
// GEMINI TEXT FOR WEB SEARCH
// ==============================

async function getGeminiText(
  key,
  model,
  message
) {

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`,
    {
      method: 'POST',

      headers: {
        'content-type': 'application/json'
      },

      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: message
              }
            ]
          }
        ],

        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 1600
        }
      })
    }
  );

  const data = await readJson(res);

  if (!res.ok || data.error) {
    throw new Error(
      data.error?.message ||
      `Gemini HTTP ${res.status}`
    );
  }

  return (
    data.candidates?.[0]?.content?.parts
      ?.map(p => p.text || '')
      .join('') || null
  );
}


// ==============================
// OPENAI COMPATIBLE TEXT
// ==============================

async function getOpenAICompatibleText(
  key,
  endpoint,
  model,
  message
) {

  const res = await fetch(endpoint, {

    method: 'POST',

    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${key}`
    },

    body: JSON.stringify({
      model,

      messages: [
        {
          role: 'user',
          content: message
        }
      ],

      temperature: 0.2
    })
  });

  const data = await readJson(res);

  if (!res.ok || data.error) {
    throw new Error(
      data.error?.message ||
      `Provider HTTP ${res.status}`
    );
  }

  return (
    data.choices?.[0]?.message?.content ||
    null
  );
}


// ==============================
// HELPERS
// ==============================

async function readJson(res) {

  const text = await res.text();

  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch {
    return {
      raw: text.slice(0, 500)
    };
  }
}


function json(obj, status = 200) {

  return new Response(
    JSON.stringify(obj),

    {
      status,

      headers: {
        ...JSON_HEADERS,
        ...corsHeaders()
      }
    }
  );
}


function corsHeaders() {

  return {
    'access-control-allow-origin': '*',

    'access-control-allow-methods':
      'POST, GET, OPTIONS',

    'access-control-allow-headers':
      'Content-Type'
  };
}


function safeError(err) {

  const msg =
    String(
      err?.message ||
      err ||
      'خطای ناشناخته'
    );

  return msg.length > 600
    ? msg.slice(0, 600)
    : msg;
}


function stripHtml(s) {

  return decodeHtml(
    String(s)
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}


function decodeHtml(s) {

  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/gi, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}
