import type { NextConfig } from 'next';

// NODE_ENV 는 설정값이 아니라 빌드 방식(개발/운영)이라 여기서 직접 본다. 앱의 설정은 src/lib/env.ts 에서만 읽는다.
const production = process.env.NODE_ENV === 'production';

// 이 앱은 외부 자원을 전혀 쓰지 않는다(글꼴·이미지·스크립트 모두 자기 출처). 화면이 인라인 스타일을 쓰고
// Next.js 가 인라인 시작 스크립트를 넣기 때문에 'unsafe-inline' 은 남긴다(nonce 방식은 모든 화면을 동적 렌더링으로 만든다).
// 그래도 외부 스크립트 로드, 다른 출처로의 전송(connect-src), 폼 전송, 프레임 삽입, <base> 바꿔치기는 막힌다.
const CSP = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${production ? '' : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const nextConfig: NextConfig = {
  poweredByHeader: false,
  serverExternalPackages: ['pg', '@node-rs/argon2'],
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'same-origin' },
          { key: 'Content-Security-Policy', value: CSP },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
          { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
          // 브라우저는 HTTPS 응답에서만 이 헤더를 따른다(HTTP 로 받은 것은 무시한다).
          ...(production ? [{ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' }] : []),
        ],
      },
    ];
  },
};

export default nextConfig;
