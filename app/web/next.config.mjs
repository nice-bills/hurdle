/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  serverExternalPackages: ["pg"],
  eslint: { ignoreDuringBuilds: true },
  webpack: (config, { webpack }) => {
    // @wagmi/connectors -> @base-org/account -> @coinbase/cdp-sdk references optional x402 packages we never load
    config.plugins.push(new webpack.IgnorePlugin({ resourceRegExp: /^@x402\// }));
    // wagmi/walletconnect optional deps that are not used in the browser bundle
    config.externals.push("pino-pretty", "lokijs", "encoding");
    config.resolve.fallback = { ...config.resolve.fallback, "@react-native-async-storage/async-storage": false };
    return config;
  },
};
export default nextConfig;
