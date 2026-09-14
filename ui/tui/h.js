/**
 * JSX yerine `h(Bileşen, props, ...çocuklar)` — derleme adımı yok (Aşama 10 kararı).
 *
 *   h(Box, { borderStyle: 'round' }, h(Text, { color: 'cyan' }, 'lofi'))
 */

import React from 'react';

export const h = React.createElement;
