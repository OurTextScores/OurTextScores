/**
 * What the demo catalogue holds. Every file is a CC0 transcription from OpenScore (see
 * ../assets/README.md), attached to the work's real IMSLP page, the way the live catalogue
 * holds the same corpora: one work per IMSLP page, one source per song or quartet.
 *
 * `filmed: true` marks the work that is added on camera, so the seed leaves it out.
 */
const lieder = (id) => ({
  description: `From the OpenScore Lieder Corpus: musescore.com/openscore-lieder-corpus/scores/${id}`,
  attribution: 'OpenScore Lieder Corpus (https://musescore.com/openscore-lieder-corpus)',
});
const quartets = (id) => ({
  description: `From OpenScore String Quartets: musescore.com/openscore-string-quartets/scores/${id}`,
  attribution: 'OpenScore String Quartets (https://musescore.com/openscore-string-quartets)',
});

export const CATALOGUE = [
  {
    key: 'dichterliebe',
    imslp: 'https://imslp.org/wiki/Dichterliebe,_Op.48_(Schumann,_Robert)',
    sources: [
      // The one the work page recommends, and the one that is played.
      { key: 'grolle', label: 'Ich grolle nicht', file: 'dichterliebe-07-ich-grolle-nicht.mscz', verified: true, ...lieder(4978382) },
      { key: 'mai', label: 'Im wunderschönen Monat Mai', file: 'dichterliebe-01-im-wunderschoenen-monat-mai.mscz', ...lieder(4976777) },
      // Clara's upload: the source the change review is about.
      { key: 'rose', label: 'Die Rose, die Lilie', file: 'dichterliebe-03-die-rose-die-lilie.mscz', by: 'clara', ...lieder(4976849) },
    ],
  },
  {
    key: 'winterreise',
    imslp: 'https://imslp.org/wiki/Winterreise,_D.911_(Schubert,_Franz)',
    sources: [
      { key: 'gute-nacht', label: 'Gute Nacht', file: 'winterreise-01-gute-nacht.mscz', verified: true, ...lieder(5015378) },
      { key: 'lindenbaum', label: 'Der Lindenbaum', file: 'winterreise-05-der-lindenbaum.mscz', ...lieder(5016466) },
    ],
  },
  {
    key: 'death-and-the-maiden',
    imslp: 'https://imslp.org/wiki/String_Quartet_No.14,_D.810_(Schubert,_Franz)',
    sources: [{ key: 'd810', label: 'String Quartet No. 14, “Death and the Maiden”', file: 'schubert-d810.mxl', ...quartets(7397765) }],
  },
  {
    key: 'dissonance',
    imslp: 'https://imslp.org/wiki/String_Quartet_No.19_in_C_major,_K.465_(Mozart,_Wolfgang_Amadeus)',
    sources: [{ key: 'k465', label: 'String Quartet No. 19, “Dissonance”', file: 'mozart-k465.mxl', verified: true, ...quartets(7471661) }],
  },
  {
    key: 'beethoven-op18-1',
    imslp: 'https://imslp.org/wiki/String_Quartet_No.1,_Op.18_No.1_(Beethoven,_Ludwig_van)',
    sources: [{ key: 'op18-1', label: 'String Quartet No. 1', file: 'beethoven-op18-1.mxl', ...quartets(8071278) }],
  },
  {
    key: 'fifths',
    imslp: 'https://imslp.org/wiki/String_Quartet_in_D_minor,_Hob.III:76_(Haydn,_Joseph)',
    sources: [{ key: 'op76-2', label: 'String Quartet Op. 76 No. 2, “Fifths”', file: 'haydn-op76-2.mxl', ...quartets(12772795) }],
  },
  {
    key: 'faure-op7',
    imslp: 'https://imslp.org/wiki/3_Songs,_Op.7_(Fauré,_Gabriel)',
    sources: [{ key: 'apres-un-reve', label: 'Après un rêve', file: 'faure-op7-1-apres-un-reve.mscz', by: 'felix', ...lieder(6810863) }],
  },
  {
    key: 'clara-schumann-op12',
    imslp: 'https://imslp.org/wiki/Lieder,_Op.12_(Schumann,_Clara)',
    sources: [{ key: 'liebst-du', label: 'Liebst du um Schönheit', file: 'clara-schumann-op12-4-liebst-du-um-schoenheit.mscz', by: 'felix', ...lieder(5000397) }],
  },
  {
    // Clara adds this one in the "Add a score" scene.
    key: 'brahms-op49',
    filmed: true,
    imslp: 'https://imslp.org/wiki/5_Lieder,_Op.49_(Brahms,_Johannes)',
    sources: [{ key: 'wiegenlied', label: 'Wiegenlied', file: 'brahms-op49-4-wiegenlied.mscz', by: 'clara', ...lieder(5701612) }],
  },
];

export const entry = (key) => CATALOGUE.find((item) => item.key === key);
