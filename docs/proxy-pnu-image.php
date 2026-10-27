<?php
// اختیاری: این بلوک را در proxy.php روی سرور رادیو، درست «قبل از» خطِ
//     if (($_GET['action'] ?? '') === 'pnu_news') {
// بگذارید. فقط وقتی لازم است که سرور اخبار نتواند مستقیم به pnu.ac.ir وصل شود؛
// آن‌وقت تصویر جلد خبرها از طریق سرور رادیو دریافت می‌شود.
// مسیر: GET proxy.php?action=pnu_image&u=https://pnu.ac.ir/...

if (($_GET['action'] ?? '') === 'pnu_image') {
    $imageUrl = (string)($_GET['u'] ?? '');
    $allowedHost = static function (string $url): bool {
        $parts = parse_url($url);
        $host  = strtolower((string)($parts['host'] ?? ''));
        return ($parts['scheme'] ?? '') === 'https' && ($host === 'pnu.ac.ir' || str_ends_with($host, '.pnu.ac.ir'));
    };
    if (!$allowedHost($imageUrl)) {
        respondJson(['error' => true, 'message' => 'نشانی تصویر مجاز نیست'], 400);
    }
    $ch = curl_init($imageUrl);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_MAXREDIRS => 3,
        CURLOPT_PROTOCOLS => CURLPROTO_HTTPS,
        CURLOPT_REDIR_PROTOCOLS => CURLPROTO_HTTPS,
        CURLOPT_CONNECTTIMEOUT => 6,
        CURLOPT_TIMEOUT => 15,
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_USERAGENT => 'Mozilla/5.0 (compatible; PNU-Radio-News/1.0)',
        CURLOPT_MAXFILESIZE => 10 * 1024 * 1024,
    ]);
    $body = curl_exec($ch);
    $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $type = (string)curl_getinfo($ch, CURLINFO_CONTENT_TYPE);
    $final = (string)curl_getinfo($ch, CURLINFO_EFFECTIVE_URL);
    if (!is_string($body) || $code >= 400 || strlen($body) > 10 * 1024 * 1024
        || !$allowedHost($final) || !preg_match('#^image/(jpeg|png|webp|gif)#i', $type)) {
        respondJson(['error' => true, 'message' => 'دریافت تصویر ناموفق بود'], 502);
    }
    http_response_code(200);
    header('Content-Type: ' . $type);
    header('Cache-Control: public, max-age=86400');
    echo $body;
    exit;
}
