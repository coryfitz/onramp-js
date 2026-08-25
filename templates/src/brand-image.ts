import { Image } from 'react-native';
import brandLockupSource from '../assets/brand-logo.png';
import brandMarkSource from '../assets/logo.png';

export const brandLockup = Image.resolveAssetSource(brandLockupSource).uri;
export const brandMark = Image.resolveAssetSource(brandMarkSource).uri;
