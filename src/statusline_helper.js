'use strict';

const LEVEL_ICONS = { comfortable: '✓', watch: '○', compact: '◐', urgent: '●', critical: '⚠' };

function composeStatuslineIcon(level, editPressure) {
  const base = LEVEL_ICONS[level] || '·';
  return editPressure ? '⚡' + base : base;
}

module.exports = { composeStatuslineIcon, LEVEL_ICONS };
