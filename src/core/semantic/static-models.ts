/** Official model2vec assets pinned to immutable Hugging Face revisions and SHA-256. */
export const STATIC_MODELS = {
  "potion-retrieval-32M": {
    revision: "6fc8051fab2a1e0ee76689cf08c853792ac285e7", dimensions: 512,
    files: {
      "model.safetensors": "07609e5bd33aad37900b3fd62f4ec96f6daec88ca4d46b9d8b928bfababf6ea0",
      "config.json": "63c00d90824c832c04ec1d02b6a983fb90489bf049f29fbff15ba481b8a432ee",
      "tokenizer.json": "7d75cbc54318138807c401b0f0c9721117c628b39de8e8e0edb6cb17e0ee7d18",
      "tokenizer_config.json": "6725995e3ab3039857ff5bd99178a7cdf42863abb04449e7bb31feb1f55fe567",
    },
  },
  "potion-multilingual-128M": {
    revision: "73908c3438cf03b6a01bcb9611d62b23d0726f08", dimensions: 256,
    files: {
      "model.safetensors": "14b5eb39cb4ce5666da8ad1f3dc6be4346e9b2d601c073302fa0a31bf7943397",
      "config.json": "595e4cab2093732efd5dbe084fd5c1826b5eea693b73b4c1fd971672867d2e54",
      "tokenizer.json": "19f1909063da3cfe3bd83a782381f040dccea475f4816de11116444a73e1b6a1",
      "tokenizer_config.json": "bd0e8c3a56aeac5078a6445e6b04425cd17b41bcc8d382ae925b5dbca287f8eb",
    },
  },
} as const;
export type StaticModelName = keyof typeof STATIC_MODELS;
