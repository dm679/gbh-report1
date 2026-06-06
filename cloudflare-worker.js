/* =============================================================================
 * Cloudflare Worker — прокси перед GitHub Pages для локального приложения Б24.
 *
 * Зачем: Битрикс24 открывает приложение в iframe POST-запросом, а GitHub Pages
 * отвечает на POST «405 Method Not Allowed». Воркер принимает любой метод
 * (POST/GET) и отдаёт соответствующий файл с GitHub Pages (всегда GET),
 * убирая заголовки, мешающие встраиванию в iframe.
 *
 * Авторизация: приложение использует только JS SDK BX24.js, который получает
 * токены через родительское окно Битрикса, поэтому тело POST не требуется.
 *
 * Установка: Cloudflare → Workers & Pages → Create → Worker → вставить этот код
 * → Deploy. Полученный адрес https://<имя>.<...>.workers.dev указать как
 * обработчик локального приложения в Битрикс24.
 * ===========================================================================*/
const BASE = 'https://dm679.github.io/gbh-report1'; // корень GitHub Pages проекта

export default {
  async fetch(request) {
    const url = new URL(request.url);
    let path = url.pathname;
    if (path === '/' || path === '') path = '/index.html';

    // всегда GET к GitHub Pages (конвертируем POST Битрикса).
    // cacheTtl:0 — не кэшировать на edge, иначе после деплоя файлы рассинхронятся.
    const upstream = await fetch(BASE + path + url.search, {
      method: 'GET',
      cf: { cacheTtl: 0, cacheEverything: false },
    });

    // отдаём как есть, но снимаем заголовки, запрещающие встраивание в iframe,
    // и просим клиента не кэшировать (всегда свежая версия приложения)
    const headers = new Headers(upstream.headers);
    headers.delete('content-security-policy');
    headers.delete('x-frame-options');
    headers.set('Cache-Control', 'no-cache, must-revalidate');
    return new Response(upstream.body, { status: upstream.status, headers });
  },
};
