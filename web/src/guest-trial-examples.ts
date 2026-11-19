// A small public sample. The full practice library stays behind the account API.
export const trialExamples = [
  {
    category: "日常交流",
    english: "Hi, how are you?",
    meaning: "嗨，你好吗？",
    zhParts: ["嗨","，","你","好吗","？"],
    groups: [
      {en: [0],zh: [0]},
      {en: [1,2],zh: [3],note: "how are you 是问候语，整体询问近况；how are 合译为“好吗”。"},
      {en: [3],zh: [2]},
    ]
  },
  {
    category: "日常交流",
    english: "Hey, is this seat taken?",
    meaning: "嗨，这个位子有人坐吗？",
    zhParts: ["嗨","，","这个","位子","有人坐吗","？"],
    groups: [
      {en: [0],zh: [0]},
      {en: [1,4],zh: [4],note: "is ... taken 是被动疑问表达，在座位语境中合译为“有人坐吗”，不是逐字翻译“被拿走”。"},
      {en: [2],zh: [2]},
      {en: [3],zh: [3]},
    ]
  },
  {
    category: "日常交流",
    english: "Could you say that again?",
    meaning: "你能再说一遍吗？",
    zhParts: ["你","能","再","说","一遍","吗","？"],
    groups: [
      {en: [0],zh: [1,5],note: "Could 构成礼貌请求，对应“能……吗”。"},
      {en: [1],zh: [0]},
      {en: [2,3],zh: [3],note: "say that 表示把刚才的话说出来，中文省略 that。"},
      {en: [4],zh: [2,4],note: "again 对应“再……一遍”，中文语序分开。"},
    ]
  },
  {
    category: "日常交流",
    english: "Could you give me an example?",
    meaning: "你能给我举个例子吗？",
    zhParts: ["你","能","给","我","举个例子","吗","？"],
    groups: [
      {en: [0],zh: [1,5],note: "Could 构成礼貌请求，对应“能……吗”。"},
      {en: [1],zh: [0]},
      {en: [2,4,5],zh: [2,4],note: "give an example 是“举个例子”，带上接受者时中文自然表达为“给……举个例子”；an 不单独翻译。"},
      {en: [3],zh: [3]},
    ]
  },
  {
    category: "日常交流",
    english: "Would you like to exchange numbers?",
    meaning: "你愿意交换电话号码吗？",
    zhParts: ["你","愿意","交换","电话号码","吗","？"],
    groups: [
      {en: [0,2],zh: [1,4],note: "would like 是礼貌询问意愿的表达，合译为“愿意……吗”。"},
      {en: [1],zh: [0]},
      {en: [3,4],zh: [2],note: "to exchange 表示愿意做的动作“交换”，to 不单独译出。"},
      {en: [5],zh: [3],note: "numbers 在联系方式语境中指电话号码。"},
    ]
  },
  {
    category: "日常交流",
    english: "Could you write it down?",
    meaning: "你能把它写下来吗？",
    zhParts: ["你","能","把它","写下来","吗","？"],
    groups: [
      {en: [0],zh: [1,4],note: "Could 构成礼貌请求，对应“能……吗”。"},
      {en: [1],zh: [0]},
      {en: [2,4],zh: [3],note: "write down 是短语动词，合译为“写下来”。"},
      {en: [3],zh: [2],note: "it 对应“它”，中文为配合句式加上“把”。"},
    ]
  },
  {
    category: "日常交流",
    english: "How is your day going?",
    meaning: "你今天过得怎么样？",
    zhParts: ["你","今天","过得","怎么样","？"],
    groups: [
      {en: [0],zh: [3]},
      {en: [1,4],zh: [2],note: "is ... going 在这里询问一天过得如何，不表示移动。"},
      {en: [2],zh: [0],note: "your day 自然译作“你今天”，your 在此对应“你”。"},
      {en: [3],zh: [1]},
    ]
  },
  {
    category: "日常交流",
    english: "Could you explain the key idea?",
    meaning: "你能解释一下核心思想吗？",
    zhParts: ["你","能","解释一下","核心","思想","吗","？"],
    groups: [
      {en: [0],zh: [1,5],note: "Could 表达礼貌请求，对应“能……吗”。"},
      {en: [1],zh: [0]},
      {en: [2],zh: [2]},
      {en: [3,4],zh: [3],note: "the key 表示特指的核心，冠词随名词短语合译。"},
      {en: [5],zh: [4]},
    ]
  },
  {
    category: "四级写作",
    english: "University students often have more freedom than they had at school, but this freedom requires careful planning.",
    meaning: "大学生往往拥有比中学时更多的自由，但这份自由需要认真规划。",
    zhParts: ["大学生","往往拥有","比中学时","更多的自由，","但","这份自由","需要","认真规划。"],
    groups: [
      {en: [0,1],zh: [0]},
      {en: [2,3],zh: [1]},
      {en: [6,7,8,9,10],zh: [2],note: "比较部分整体表示“比中学时”；had 的宾语 freedom 省略了。"},
      {en: [4,5],zh: [3]},
      {en: [11],zh: [4]},
      {en: [12,13],zh: [5]},
      {en: [14],zh: [6]},
      {en: [15,16],zh: [7]},
    ]
  },
  {
    category: "四级写作",
    english: "Many students read messages throughout the day, yet they rarely spend quiet time with a book.",
    meaning: "许多学生一整天都在阅读消息，然而他们很少安静地花些时间读一本书。",
    zhParts: ["许多学生","一整天都在","阅读消息，","然而","他们很少","安静地花些时间","读一本书。"],
    groups: [
      {en: [0,1],zh: [0]},
      {en: [2,3],zh: [2]},
      {en: [4,5,6],zh: [1],note: "throughout the day 表示“整天”。"},
      {en: [7],zh: [3]},
      {en: [8,9],zh: [4]},
      {en: [10,11,12],zh: [5],note: "spend quiet time 合译为“安静地花些时间”。"},
      {en: [13,14,15],zh: [6],note: "spend time with a book 在这里表示花时间阅读。"},
    ]
  },
  {
    category: "六级写作",
    english: "As artificial intelligence enters university classrooms, students are gaining access to instant explanations and personalized feedback.",
    meaning: "随着人工智能进入大学课堂，学生正在获得即时讲解和个性化反馈。",
    zhParts: ["随着人工智能进入大学课堂，","学生正在获得","即时讲解和个性化反馈。"],
    groups: [
      {en: [0,1,2,3,4,5],zh: [0],note: "按语义词组理解，冠词、助动词等随所属表达合译。"},
      {en: [6,7,8,9,10],zh: [1],note: "按语义词组理解，冠词、助动词等随所属表达合译。"},
      {en: [11,12,13,14,15],zh: [2],note: "按语义词组理解，冠词、助动词等随所属表达合译。"},
    ]
  },
  {
    category: "六级写作",
    english: "University students encounter an enormous amount of information through social media, online lectures, and everyday conversations.",
    meaning: "大学生接触到海量信息，来源包括社交媒体、在线讲座和日常交流。",
    zhParts: ["大学生接触到海量信息，","来源包括社交媒体、在线讲座和日常交流。"],
    groups: [
      {en: [0,1,2,3,4,5,6,7],zh: [0],note: "按语义词组理解，冠词、助动词等随所属表达合译。"},
      {en: [8,9,10,11,12,13,14,15],zh: [1],note: "按语义词组理解，冠词、助动词等随所属表达合译。"},
    ]
  },
];
