import { Directory, File, Paths } from 'expo-file-system';
import * as ImageManipulator from 'expo-image-manipulator';
import * as Crypto from 'expo-crypto';
export async function retainPhoto(uri: string) {
  const resized = await ImageManipulator.manipulateAsync(uri, [{ resize: { width: 1200 } }], { compress: 0.8, format: ImageManipulator.SaveFormat.JPEG });
  const folder = new Directory(Paths.document, 'private-selfies'); folder.create({ idempotent: true, intermediates: true });
  const destination = new File(folder, `${Crypto.randomUUID()}.jpg`);
  new File(resized.uri).copy(destination);
  await deletePhoto(resized.uri); await deletePhoto(uri);
  return destination.uri;
}
export async function deletePhoto(uri: string) {
  if (!uri.startsWith(Paths.cache.uri) && !uri.startsWith(new Directory(Paths.document, 'private-selfies').uri + '/')) return;
  const file = new File(uri); if (file.exists) file.delete();
}
