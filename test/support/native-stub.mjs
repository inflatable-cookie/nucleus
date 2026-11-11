// Host stand-ins for react-native and the plugin's native components, so client
// components mount under node in test/support/render.ts.
export const View = 'View', Text = 'Text', Pressable = 'Pressable', ScrollView = 'ScrollView', TextInput = 'TextInput', Modal = 'Modal', Icon = 'Icon';
// Mutable so a test can take the web branch (a real `<input>`) and restore it.
export const Platform = { OS: 'ios' };
export const useWindowDimensions = () => ({ width: 1440, height: 900, scale: 2, fontScale: 1 });
