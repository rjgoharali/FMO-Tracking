import type { ConfigContext, ExpoConfig } from 'expo/config';
export default ({ config }: ConfigContext): ExpoConfig => {
  const development = process.env.APP_VARIANT !== 'production';
  const api = process.env.EXPO_PUBLIC_API_URL ?? '';
  if (!development && !api.startsWith('https://')) throw new Error('Production builds require EXPO_PUBLIC_API_URL with HTTPS');
  return { ...config, name: development ? 'FMO Field · Dev' : 'FMO Field', slug: 'fmo-field', version: '0.3.0', orientation: 'portrait',
    platforms: ['android'], userInterfaceStyle: 'light', scheme: 'fmofield',
    android: { package: development ? 'org.fieldoperations.fmo.dev' : 'org.fieldoperations.fmo', versionCode: 3,
      allowBackup: false, permissions: ['android.permission.POST_NOTIFICATIONS'],
      blockedPermissions: ['android.permission.RECORD_AUDIO', 'android.permission.READ_MEDIA_IMAGES', 'android.permission.READ_MEDIA_VIDEO', 'android.permission.READ_EXTERNAL_STORAGE', 'android.permission.WRITE_EXTERNAL_STORAGE'] },
    plugins: [
      ['expo-location', { isAndroidBackgroundLocationEnabled: true, isAndroidForegroundServiceEnabled: true }],
      ['expo-camera', { cameraPermission: 'Capture a live selfie to confirm duty attendance.', recordAudioAndroid: false }],
      'expo-sqlite', 'expo-secure-store', './plugins/with-network-policy.cjs',
    ],
    extra: { developmentBuild: development, eas: { projectId: 'b525d7b3-e47b-4844-bb13-6a06a9d8e152' } },
  };
};
