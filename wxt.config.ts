import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'src',
  manifest: {
    name: 'EIP Helper',
    description:
      'Highlights EIP/ERC references on any page. Hover for the full title, status, and links to the spec, discussion, and source.',
    // storage is the ONLY permission. No host permissions, no tabs, no
    // web_accessible_resources -- the dataset ships bundled, so the extension
    // has no way to observe browsing and nothing for a page to fingerprint.
    permissions: ['storage'],
  },
});
