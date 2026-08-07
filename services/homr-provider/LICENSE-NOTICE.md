The provider code in this directory is part of OurTextScores and is licensed
under the GNU Affero General Public License version 3 or later.

It installs and invokes HOMR, which is licensed under AGPL-3.0. HOMR source:
https://github.com/liebharc/homr at commit
`1ddc6fcc26c4baa746eaffbba7f5e01429063465`.

Because the deployed service is reached over a network, AGPL section 13 applies.
The corresponding source of the exact deployed provider — this directory plus
the deploying `homr-cpu` or `homr-modal` entry point — must remain publicly
available, and `GET /v1/capabilities` returns the source URL and licence
identifiers so that network users can find it.
