import type { Metadata } from "next";
import "./globals.css";
import FirebaseInit from "@/components/FirebaseInit";

export const metadata: Metadata = {
  title: "선결제 주문",
  description: "선결제 주문 시스템",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko" className="h-full">
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover" />
        {/* Pretendard — 주문번호처럼 숫자와 한글이 한 줄에 서는 자리에 쓴다.
            시스템 한글 폰트(Apple SD Gothic Neo / 맑은 고딕)는 기기마다 숫자 폭과
            한글 높이가 달라서, '주문번호 042' 가 아이폰과 안드로이드에서 다른 줄로
            보인다. dynamic-subset 은 쓰는 글자만 받아와서 가볍다.
            preconnect 를 먼저 두는 이유: 폰트 CSS 가 같은 호스트의 woff2 를 다시
            부르므로 연결을 미리 열어두면 첫 렌더에서 글자가 늦게 바뀌는 걸 줄인다. */}
        <link rel="preconnect" href="https://cdn.jsdelivr.net" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css"
        />
      </head>
      <body className="min-h-full" style={{ backgroundColor: '#E5E5E5' }}>
        <FirebaseInit />
        {children}
      </body>
    </html>
  );
}
