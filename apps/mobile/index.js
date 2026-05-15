/**
 * 노동자의 지갑 — RN entry point.
 * Component name must match `name` in app.json.
 */
import { AppRegistry } from 'react-native';
import App from './App';
import appInfo from './app.json';

AppRegistry.registerComponent(appInfo.name, () => App);
