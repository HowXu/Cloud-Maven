export interface IntroConfig {
  imageUrl: string;
  title: string;
  lines: string[];
}

export const introConfig: IntroConfig = {
  imageUrl: "http://q1.qlogo.cn/g?b=qq&nk=672252397&s=640",
  title: "Cloud Maven",
  lines: [
    "基于 Cloudflare Workers的轻量 Maven 仓库",
    "https://github.com/HowXu/cloud-maven"
  ],
};
