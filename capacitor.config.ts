import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.livhi.app',
  appName: 'LivHI',
  webDir: 'dist',
  server: {
    androidScheme: 'https'
  },
  plugins: {
    Geolocation: {
      // Configuration if needed
    },
    Camera: {
      // Configuration if needed
    }
  }
};

export default config;
