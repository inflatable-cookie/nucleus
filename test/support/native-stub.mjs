// Host stand-ins for react-native and the plugin's native components, so client
// components mount under node in test/support/render.ts.
export const View = 'View', Text = 'Text', Pressable = 'Pressable', ScrollView = 'ScrollView', TextInput = 'TextInput', Modal = 'Modal', Image = 'Image', Icon = 'Icon';
// Mutable so a test can take the web branch (a real `<input>`) and restore it.
export const Platform = { OS: 'ios' };
// Records the URLs a component opens, so a test can assert a link without a browser.
// Shared through globalThis: the client may load this stub through require and a test through import.
export const Linking = (globalThis.__nucleusStubLinking ??= { opened: [], openURL(url) { this.opened.push(url); return Promise.resolve(true); } });
// Styles pass through unchanged; web-only keys such as keyframes stay readable.
export const StyleSheet = { create: styles => styles };
export const useWindowDimensions = () => ({ width: 1440, height: 900, scale: 2, fontScale: 1 });
