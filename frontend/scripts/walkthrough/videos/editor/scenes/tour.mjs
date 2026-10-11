import { id, SCORES, stage } from '../editor.mjs';

export default {
  id: 'tour',
  chapter: 'The workspace',
  async setup(t) {
    await stage(t, { score: SCORES.faure, dock: true });
  },
  async run(t) {
    t.caption('Every command has a place in the menus.');
    await t.click(id(t, 'menu-add'));
    await t.hold(500);
    await t.hover(id(t, 'menu-sub-text'), { after: 1300 });
    await t.snap('menu-text');
    await t.hover(id(t, 'menu-sub-lines'), { after: 1000 });
    await t.hover(id(t, 'menu-sub-marks'), { after: 1100 });
    await t.snap('menu-marks');
    await t.page.keyboard.press('Escape');
    await t.page.keyboard.press('Escape');
    await t.hold(400);

    t.caption('The toolbar keeps the common ones a click away, and folds up when you want room.');
    await t.callout(id(t, 'tool-strip'), '', { pad: 2 });
    await t.hover(id(t, 'btn-duration-4'), { after: 500 });
    await t.hover(id(t, 'btn-slur'), { after: 500 });
    await t.hover(id(t, 'dropdown-markings-last'), { after: 500 });
    await t.hover(id(t, 'dropdown-key'), { after: 700 });
    await t.snap('toolbar');
    await t.clearCallout();
    // Hiding the tools also matters for what follows: dialogs sit below the toolbar, and a tall
    // one (the shortcut list) would have its top covered.
    await t.click(id(t, 'btn-tool-strip-toggle'), { after: 1300 });
    await t.snap('tools-hidden');

    t.caption('Palettes, instruments and properties share the side panel.');
    await t.click(id(t, 'dock-tab-instruments'), { after: 1300 });
    await t.snap('instruments');
    await t.click(id(t, 'dock-tab-properties'), { after: 1100 });
    await t.click(id(t, 'dock-tab-palettes'), { after: 900 });

    t.caption('The command palette finds any command by name.');
    await t.click(id(t, 'shell-palette-button'));
    await t.text('transpose', { delay: 85 });
    await t.hold(1700);
    await t.snap('palette');
    await t.page.keyboard.press('Escape');
    await t.hold(500);

    t.caption('And the shortcuts are the ones MuseScore users already know.');
    await t.click(id(t, 'menu-help'));
    await t.hold(350);
    await t.click(id(t, 'menu-item-help.shortcuts'));
    await t.hold(3400);
    await t.snap('shortcuts');
    await t.page.keyboard.press('Escape');
    await t.hold(500);
  },
};
