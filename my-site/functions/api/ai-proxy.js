// functions/api/ai-proxy.js
// این فایل باید روی Cloudflare Pages دیپلوی شود (کنار پوشه‌ی سایت، در مسیر functions/api/ai-proxy.js)
// آدرس نهایی آن به‌صورت خودکار: https://your-site.pages.dev/api/ai-proxy
//
// نکته‌ی امنیتی مهم:
// کلیدهای واقعی هرگز داخل این فایل یا هر فایل دیگری که در گیت/سایت قرار می‌گیرد نوشته نشوند.
// در پنل Cloudflare Pages بروید به: Settings > Environment variables
// و سه متغیر زیر را با مقدار واقعی کلیدهایتان اضافه کنید (نوع: Secret):
//   GEMINI_API_KEY
//   GROQ_API_KEY
//   DEEPSEEK_API_KEY
// این‌طوری کلیدها فقط روی سرور Cloudflare می‌مانند و در مرورگر هیچ بازدیدکننده‌ای قابل مشاهده نیستند.

export async function onRequestPost(context) {
    const { request, env } = context;

    let body;
    try {
        body = await request.json();
    } catch {
        return jsonResponse({ error: 'بدنه درخواست نامعتبر است.' }, 400);
    }

    const { provider, model, message } = body;
    if (!provider || !model || !message) {
        return jsonResponse({ error: 'provider, model و message الزامی هستند.' }, 400);
    }

    try {
        if (provider === 'gemini') {
            const key = env.GEMINI_API_KEY;
            if (!key) return jsonResponse({ error: 'GEMINI_API_KEY روی سرور تنظیم نشده است.' }, 500);

            const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ contents: [{ parts: [{ text: message }] }] })
            });
            const data = await readUpstreamJson(res);
            if (data.error) return jsonResponse({ error: data.error.message }, 502);
            const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
            return jsonResponse({ text });
        }

        if (provider === 'groq' || provider === 'deepseek') {
            const key = provider === 'groq' ? env.GROQ_API_KEY : env.DEEPSEEK_API_KEY;
            if (!key) return jsonResponse({ error: `کلید ${provider.toUpperCase()}_API_KEY روی سرور تنظیم نشده است.` }, 500);

            const endpoint = provider === 'groq'
                ? 'https://api.groq.com/openai/v1/chat/completions'
                : 'https://api.deepseek.com/chat/completions';

            const res = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
                body: JSON.stringify({ model, messages: [{ role: 'user', content: message }] })
            });
            const data = await readUpstreamJson(res);
            if (data.error) return jsonResponse({ error: data.error.message || 'خطای سرویس' }, 502);
            const text = data.choices?.[0]?.message?.content || '';
            return jsonResponse({ text });
        }

        return jsonResponse({ error: 'سرویس پشتیبانی‌نشده برای پروکسی.' }, 400);
    } catch (err) {
        return jsonResponse({ error: 'خطای داخلی سرور: ' + err.message }, 500);
    }
}

function jsonResponse(obj, status = 200) {
    return new Response(JSON.stringify(obj), {
        status,
        headers: { 'Content-Type': 'application/json' }
    });
}

// خواندن ایمن پاسخ سرویس‌های بیرونی (Gemini/Groq/DeepSeek)؛ اگر بدنه خالی یا غیر-JSON بود، خطای روشن برمی‌گرداند
async function readUpstreamJson(res) {
    const text = await res.text();
    if (!text) {
        throw new Error(`پاسخ خالی از سرویس دریافت شد (کد وضعیت ${res.status}).`);
    }
    try {
        return JSON.parse(text);
    } catch {
        throw new Error(`پاسخ سرویس JSON معتبر نبود (کد وضعیت ${res.status}): ${text.slice(0, 300)}`);
    }
}
