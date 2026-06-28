import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.hdduong.flexiblereminder',
  appName: 'Flexible Reminder',
  webDir: 'dist',
  ios: {
    path: '../ios',
  },
};

export default config;
